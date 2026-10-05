//! SPOILS SOL market (devnet): players trade SPOILS items for SOL without trusting the game.
//!
//! An item a player sends from the game to their wallet is a Metaplex Core asset in the SPOILS
//! collection. To sell it, the owner lists it here: the asset moves into escrow (owned by the
//! listing PDA) and the price is stored on chain. A buyer pays in one atomic transaction: SOL goes
//! to the seller minus the market fee (to the treasury) and the asset goes to the buyer, or nothing
//! happens at all. The seller can cancel and take the asset back at any time before a sale. The
//! game server never holds a seller's SOL or a listed item.
//!
//! Core is called by hand-built CPI (TransferV1, discriminator 14) instead of the mpl-core crate,
//! which keeps the dependency tree to anchor-lang alone.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;

declare_id!("3eu7K4GkLw1CA74Z4JSadBjsxZHNpaauWTtky6u52eGB");

/// Metaplex Core program (same id on devnet and mainnet).
pub const CORE_ID: Pubkey = pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
pub const MARKET_SEED: &[u8] = b"market";
pub const LISTING_SEED: &[u8] = b"listing";
/// Highest market fee the admin can set: 20 %.
pub const MAX_FEE_BPS: u16 = 2_000;
/// Upper bound on one price (1 000 SOL) so a typo cannot create an absurd lot.
pub const MAX_PRICE_LAMPORTS: u64 = 1_000 * 1_000_000_000;
/// Core TransferV1 instruction data: discriminator 14, compression_proof = None.
pub const CORE_TRANSFER_V1: [u8; 2] = [14, 0];

#[program]
pub mod spoils_market {
    use super::*;

    /// One-time setup by the program's upgrade authority (nobody can claim the market first).
    pub fn initialize(ctx: Context<Initialize>, collection: Pubkey, treasury: Pubkey, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, MarketError::FeeTooHigh);
        let m = &mut ctx.accounts.market;
        m.admin = ctx.accounts.payer.key();
        m.collection = collection;
        m.treasury = treasury;
        m.fee_bps = fee_bps;
        m.listed = 0;
        m.sold = 0;
        m.volume_lamports = 0;
        m.bump = ctx.bumps.market;
        Ok(())
    }

    /// Admin changes the fee or the treasury. Listings already open keep trading under the new fee.
    pub fn update_config(ctx: Context<UpdateConfig>, treasury: Pubkey, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, MarketError::FeeTooHigh);
        let m = &mut ctx.accounts.market;
        m.treasury = treasury;
        m.fee_bps = fee_bps;
        Ok(())
    }

    /// Puts a SPOILS item up for sale: the asset moves from the seller into escrow.
    pub fn list(ctx: Context<List>, price_lamports: u64) -> Result<()> {
        check_price(price_lamports)?;
        let data = ctx.accounts.asset.try_borrow_data()?;
        check_asset(&data, &ctx.accounts.seller.key(), &ctx.accounts.market.collection)?;
        drop(data);

        let now = Clock::get()?.unix_timestamp;
        {
            let l = &mut ctx.accounts.listing;
            l.seller = ctx.accounts.seller.key();
            l.asset = ctx.accounts.asset.key();
            l.price_lamports = price_lamports;
            l.created_at = now;
            l.bump = ctx.bumps.listing;
        }

        core_transfer(
            &ctx.accounts.asset,
            &ctx.accounts.collection,
            &ctx.accounts.seller.to_account_info(),
            &ctx.accounts.seller.to_account_info(),
            &ctx.accounts.listing.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.core_program,
            &[],
        )?;
        let m = &mut ctx.accounts.market;
        m.listed = m.listed.checked_add(1).ok_or(MarketError::Overflow)?;
        emit!(Listed { asset: ctx.accounts.asset.key(), seller: ctx.accounts.seller.key(), price_lamports, ts: now });
        Ok(())
    }

    /// Buys a lot: SOL to the seller (minus the fee to the treasury), the asset to the buyer.
    pub fn buy(ctx: Context<Buy>) -> Result<()> {
        let price = ctx.accounts.listing.price_lamports;
        require_keys_neq!(ctx.accounts.buyer.key(), ctx.accounts.seller.key(), MarketError::OwnListing);
        let (fee, net) = split_price(price, ctx.accounts.market.fee_bps)?;

        let sys = ctx.accounts.system_program.to_account_info();
        system_program::transfer(
            CpiContext::new(sys.clone(), system_program::Transfer { from: ctx.accounts.buyer.to_account_info(), to: ctx.accounts.seller.to_account_info() }),
            net,
        )?;
        if fee > 0 {
            system_program::transfer(
                CpiContext::new(sys.clone(), system_program::Transfer { from: ctx.accounts.buyer.to_account_info(), to: ctx.accounts.treasury.to_account_info() }),
                fee,
            )?;
        }

        let asset_key = ctx.accounts.asset.key();
        let bump = [ctx.accounts.listing.bump];
        let seeds: &[&[u8]] = &[LISTING_SEED, asset_key.as_ref(), &bump];
        core_transfer(
            &ctx.accounts.asset,
            &ctx.accounts.collection,
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.listing.to_account_info(),
            &ctx.accounts.buyer.to_account_info(),
            &sys,
            &ctx.accounts.core_program,
            &[seeds],
        )?;

        let m = &mut ctx.accounts.market;
        m.sold = m.sold.checked_add(1).ok_or(MarketError::Overflow)?;
        m.volume_lamports = m.volume_lamports.checked_add(price).ok_or(MarketError::Overflow)?;
        emit!(Sold {
            asset: asset_key,
            seller: ctx.accounts.seller.key(),
            buyer: ctx.accounts.buyer.key(),
            price_lamports: price,
            fee_lamports: fee,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// The seller takes the asset back; the listing rent returns to them.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let asset_key = ctx.accounts.asset.key();
        let bump = [ctx.accounts.listing.bump];
        let seeds: &[&[u8]] = &[LISTING_SEED, asset_key.as_ref(), &bump];
        core_transfer(
            &ctx.accounts.asset,
            &ctx.accounts.collection,
            &ctx.accounts.seller.to_account_info(),
            &ctx.accounts.listing.to_account_info(),
            &ctx.accounts.seller.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.core_program,
            &[seeds],
        )?;
        emit!(Cancelled { asset: asset_key, seller: ctx.accounts.seller.key(), ts: Clock::get()?.unix_timestamp });
        Ok(())
    }
}

// ---------------------------------------------------------------------------- rules

pub fn check_price(price_lamports: u64) -> Result<()> {
    require!(price_lamports > 0 && price_lamports <= MAX_PRICE_LAMPORTS, MarketError::BadPrice);
    Ok(())
}

/// (fee, seller's net). The fee is rounded up so the treasury never loses a lamport to rounding.
pub fn split_price(price: u64, fee_bps: u16) -> Result<(u64, u64)> {
    let fee = (price as u128 * fee_bps as u128 + 9_999) / 10_000;
    let fee = u64::try_from(fee).map_err(|_| MarketError::Overflow)?;
    Ok((fee, price.checked_sub(fee).ok_or(MarketError::Overflow)?))
}

/// A Core AssetV1 owned by `owner` whose update authority is the SPOILS `collection`.
/// Layout: key u8 (1 = AssetV1) | owner [32] | update authority tag u8 (2 = Collection) | address [32] | …
pub fn check_asset(data: &[u8], owner: &Pubkey, collection: &Pubkey) -> Result<()> {
    require!(data.len() >= 66 && data[0] == 1, MarketError::NotAnAsset);
    require!(&data[1..33] == owner.as_ref(), MarketError::NotOwner);
    require!(data[33] == 2 && &data[34..66] == collection.as_ref(), MarketError::WrongCollection);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn core_transfer<'info>(
    asset: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    new_owner: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    core_program: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(asset.key(), false),
            AccountMeta::new_readonly(collection.key(), false),
            AccountMeta::new(payer.key(), true),
            AccountMeta::new_readonly(authority.key(), true),
            AccountMeta::new_readonly(new_owner.key(), false),
            AccountMeta::new_readonly(system_program.key(), false),
            // log_wrapper: None (Core takes its own id for an absent optional account).
            AccountMeta::new_readonly(CORE_ID, false),
        ],
        data: CORE_TRANSFER_V1.to_vec(),
    };
    invoke_signed(
        &ix,
        &[asset.clone(), collection.clone(), payer.clone(), authority.clone(), new_owner.clone(), system_program.clone(), core_program.clone()],
        signer_seeds,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------- accounts

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub admin: Pubkey,
    /// The SPOILS Core collection: only its assets can be listed.
    pub collection: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub listed: u64,
    pub sold: u64,
    pub volume_lamports: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub seller: Pubkey,
    pub asset: Pubkey,
    pub price_lamports: u64,
    pub created_at: i64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + Market::INIT_SPACE, seeds = [MARKET_SEED], bump)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ MarketError::BadProgramData)]
    pub program: Program<'info, crate::program::SpoilsMarket>,
    #[account(constraint = program_data.upgrade_authority_address == Some(payer.key()) @ MarketError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [MARKET_SEED], bump = market.bump, has_one = admin @ MarketError::Unauthorized)]
    pub market: Account<'info, Market>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct List<'info> {
    #[account(mut, seeds = [MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = seller, space = 8 + Listing::INIT_SPACE, seeds = [LISTING_SEED, asset.key().as_ref()], bump)]
    pub listing: Account<'info, Listing>,
    /// CHECK: a Core asset; owner program, layout, owner and collection are checked in `list`.
    #[account(mut, owner = CORE_ID @ MarketError::NotAnAsset)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: the SPOILS collection stored in the market config.
    #[account(address = market.collection @ MarketError::WrongCollection)]
    pub collection: UncheckedAccount<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = CORE_ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut, seeds = [MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        close = seller,
        seeds = [LISTING_SEED, asset.key().as_ref()],
        bump = listing.bump,
        has_one = seller @ MarketError::WrongSeller,
        has_one = asset @ MarketError::NotAnAsset,
    )]
    pub listing: Account<'info, Listing>,
    /// CHECK: the escrowed Core asset (listing.asset).
    #[account(mut, owner = CORE_ID @ MarketError::NotAnAsset)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: the SPOILS collection.
    #[account(address = market.collection @ MarketError::WrongCollection)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: receives the SOL and the listing rent; must be listing.seller.
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: receives the fee; must be market.treasury.
    #[account(mut, address = market.treasury @ MarketError::WrongTreasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = CORE_ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(seeds = [MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        close = seller,
        seeds = [LISTING_SEED, asset.key().as_ref()],
        bump = listing.bump,
        has_one = seller @ MarketError::WrongSeller,
        has_one = asset @ MarketError::NotAnAsset,
    )]
    pub listing: Account<'info, Listing>,
    /// CHECK: the escrowed Core asset (listing.asset).
    #[account(mut, owner = CORE_ID @ MarketError::NotAnAsset)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: the SPOILS collection.
    #[account(address = market.collection @ MarketError::WrongCollection)]
    pub collection: UncheckedAccount<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = CORE_ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------- events

#[event]
pub struct Listed {
    pub asset: Pubkey,
    pub seller: Pubkey,
    pub price_lamports: u64,
    pub ts: i64,
}

#[event]
pub struct Sold {
    pub asset: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub price_lamports: u64,
    pub fee_lamports: u64,
    pub ts: i64,
}

#[event]
pub struct Cancelled {
    pub asset: Pubkey,
    pub seller: Pubkey,
    pub ts: i64,
}

#[error_code]
pub enum MarketError {
    #[msg("Signer is not allowed to do this")]
    Unauthorized,
    #[msg("Program data account does not belong to this program")]
    BadProgramData,
    #[msg("Fee above the 20 % cap")]
    FeeTooHigh,
    #[msg("Price must be above zero and at most 1000 SOL")]
    BadPrice,
    #[msg("Not a Metaplex Core asset")]
    NotAnAsset,
    #[msg("The signer does not own this asset")]
    NotOwner,
    #[msg("Only SPOILS items can be listed")]
    WrongCollection,
    #[msg("Seller does not match the listing")]
    WrongSeller,
    #[msg("Treasury does not match the market config")]
    WrongTreasury,
    #[msg("You cannot buy your own listing")]
    OwnListing,
    #[msg("Arithmetic overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::Discriminator;

    fn asset_bytes(key: u8, owner: &Pubkey, tag: u8, ua: &Pubkey) -> Vec<u8> {
        let mut d = vec![key];
        d.extend_from_slice(owner.as_ref());
        d.push(tag);
        d.extend_from_slice(ua.as_ref());
        d.extend_from_slice(&[4, 0, 0, 0, b'n', b'a', b'm', b'e']);
        d
    }

    #[test]
    fn fee_rounds_up_for_the_treasury_and_net_adds_back_to_price() {
        assert_eq!(split_price(1_000_000_000, 500).unwrap(), (50_000_000, 950_000_000));
        assert_eq!(split_price(1, 500).unwrap(), (1, 0));
        assert_eq!(split_price(10_001, 500).unwrap(), (501, 9_500));
        assert_eq!(split_price(777, 0).unwrap(), (0, 777));
        let (f, n) = split_price(MAX_PRICE_LAMPORTS, MAX_FEE_BPS).unwrap();
        assert_eq!(f + n, MAX_PRICE_LAMPORTS);
    }

    #[test]
    fn price_must_be_positive_and_capped() {
        assert!(check_price(0).is_err());
        assert!(check_price(1).is_ok());
        assert!(check_price(MAX_PRICE_LAMPORTS).is_ok());
        assert!(check_price(MAX_PRICE_LAMPORTS + 1).is_err());
    }

    #[test]
    fn only_spoils_assets_of_the_signer_pass() {
        let owner = Pubkey::new_unique();
        let col = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        assert!(check_asset(&asset_bytes(1, &owner, 2, &col), &owner, &col).is_ok());
        assert!(check_asset(&asset_bytes(1, &other, 2, &col), &owner, &col).is_err(), "not the owner");
        assert!(check_asset(&asset_bytes(1, &owner, 2, &other), &owner, &col).is_err(), "another collection");
        assert!(check_asset(&asset_bytes(1, &owner, 1, &col), &owner, &col).is_err(), "address authority, not a collection");
        assert!(check_asset(&asset_bytes(5, &owner, 2, &col), &owner, &col).is_err(), "a collection account, not an asset");
        assert!(check_asset(&[1, 2, 3], &owner, &col).is_err(), "too short");
    }

    /// The web encoder (apps/web/src/lib/onchain/market-program.ts) builds instructions by hand:
    /// these are the first 8 bytes of sha256("global:<name>") / ("account:<Name>").
    #[test]
    fn discriminators_are_the_anchor_sha256_prefixes() {
        assert_eq!(instruction::List::DISCRIMINATOR, [54, 174, 193, 67, 17, 41, 132, 38]);
        assert_eq!(instruction::Buy::DISCRIMINATOR, [102, 6, 61, 18, 1, 218, 235, 234]);
        assert_eq!(instruction::Cancel::DISCRIMINATOR, [232, 219, 223, 41, 219, 236, 220, 190]);
        assert_eq!(instruction::Initialize::DISCRIMINATOR, [175, 175, 109, 31, 13, 152, 155, 237]);
        assert_eq!(Listing::DISCRIMINATOR, [218, 32, 50, 73, 43, 134, 26, 58]);
        assert_eq!(Market::DISCRIMINATOR, [219, 190, 213, 55, 0, 227, 198, 154]);
    }

    #[test]
    fn account_spaces_fit_the_fields() {
        assert_eq!(Listing::INIT_SPACE, 32 + 32 + 8 + 8 + 1);
        assert_eq!(Market::INIT_SPACE, 32 * 3 + 2 + 8 * 3 + 1);
    }
}
