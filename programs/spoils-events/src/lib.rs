//! SPOILS game results on Solana (devnet).
//!
//! The game's web server is the only writer. One `Config` PDA (seed "config") holds the server
//! authority key and three counters; every `record_*` instruction checks that signer, bumps a
//! counter and emits an event into the transaction log. No account is created per event, so a
//! record costs only the transaction fee, paid by the server. Players never sign and never pay.
//!
//! No raw user ids, nicknames or emails ever reach the chain: `killer_hash` and `owner_hash` are
//! sha256(server salt ‖ id) and `match_hash` is sha256 of the canonical end report, all computed
//! off chain (apps/web/src/lib/chain).
use anchor_lang::prelude::*;

declare_id!("8Jc6sbbLY7PoJ2wms33k9MzYmMBdidH96vX4nLFbqf9B");

/// Seed of the single Config PDA.
pub const CONFIG_SEED: &[u8] = b"config";
/// Highest rarity index: 0 common, 1 rare, 2 epic, 3 legendary (packages/shared RARITY_NAMES).
pub const MAX_RARITY: u8 = 3;

#[program]
pub mod spoils_events {
    use super::*;

    /// One-time setup. Only the program's upgrade authority may create the Config, so nobody can
    /// claim it between the deploy and this call.
    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = authority;
        config.matches = 0;
        config.boss_kills = 0;
        config.rare_extracts = 0;
        config.bump = ctx.bumps.config;
        emit!(AuthoritySet { old: Pubkey::default(), new: authority });
        Ok(())
    }

    /// Rotates the record signer. Signed by the current authority, or by the upgrade authority
    /// (recovery when the server key is lost or leaked).
    pub fn set_authority(ctx: Context<SetAuthority>, new_authority: Pubkey) -> Result<()> {
        let signer = ctx.accounts.signer.key();
        let config = &mut ctx.accounts.config;
        require!(
            may_set_authority(&signer, &config.authority, ctx.accounts.program_data.upgrade_authority_address),
            SpoilsError::Unauthorized
        );
        let old = config.authority;
        config.authority = new_authority;
        emit!(AuthoritySet { old, new: new_authority });
        Ok(())
    }

    /// A world shard ended and the web settled it.
    pub fn record_match(
        ctx: Context<Record>,
        cycle_id: u64,
        shard: u8,
        match_hash: [u8; 32],
        humans: u16,
        mia: u16,
    ) -> Result<()> {
        check_match(humans, mia)?;
        let seq = next_seq(&mut ctx.accounts.config.matches)?;
        emit!(MatchRecorded { seq, cycle_id, shard, match_hash, humans, mia, ts: Clock::get()?.unix_timestamp });
        Ok(())
    }

    /// The event boss of a shard died. `boss_kind` is the index in packages/shared BOSS_KINDS.
    pub fn record_boss_kill(ctx: Context<Record>, cycle_id: u64, boss_kind: u8, killer_hash: [u8; 32]) -> Result<()> {
        let seq = next_seq(&mut ctx.accounts.config.boss_kills)?;
        emit!(BossKillRecorded { seq, cycle_id, boss_kind, killer_hash, ts: Clock::get()?.unix_timestamp });
        Ok(())
    }

    /// A player brought a rare item out of the map.
    pub fn record_rare_extract(
        ctx: Context<Record>,
        cycle_id: u64,
        item_def_hash: [u8; 32],
        rarity: u8,
        owner_hash: [u8; 32],
    ) -> Result<()> {
        check_rarity(rarity)?;
        let seq = next_seq(&mut ctx.accounts.config.rare_extracts)?;
        emit!(RareExtractRecorded { seq, cycle_id, item_def_hash, rarity, owner_hash, ts: Clock::get()?.unix_timestamp });
        Ok(())
    }
}

// ---------------------------------------------------------------------------- rules

/// Bumps a counter and returns the new value (the event's sequence number, starting at 1).
pub fn next_seq(counter: &mut u64) -> Result<u64> {
    *counter = counter.checked_add(1).ok_or(SpoilsError::CounterOverflow)?;
    Ok(*counter)
}

/// Missing-in-action players are a subset of the humans of the shard.
pub fn check_match(humans: u16, mia: u16) -> Result<()> {
    require!(mia <= humans, SpoilsError::MiaExceedsHumans);
    Ok(())
}

pub fn check_rarity(rarity: u8) -> Result<()> {
    require!(rarity <= MAX_RARITY, SpoilsError::BadRarity);
    Ok(())
}

pub fn may_set_authority(signer: &Pubkey, current: &Pubkey, upgrade_authority: Option<Pubkey>) -> bool {
    signer == current || upgrade_authority.as_ref() == Some(signer)
}

// ---------------------------------------------------------------------------- accounts

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// The only key allowed to record (the web server's CHAIN_AUTHORITY_SECRET).
    pub authority: Pubkey,
    pub matches: u64,
    pub boss_kills: u64,
    pub rare_extracts: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ SpoilsError::BadProgramData)]
    pub program: Program<'info, crate::program::SpoilsEvents>,
    #[account(constraint = program_data.upgrade_authority_address == Some(payer.key()) @ SpoilsError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub signer: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ SpoilsError::BadProgramData)]
    pub program: Program<'info, crate::program::SpoilsEvents>,
    pub program_data: Account<'info, ProgramData>,
}

#[derive(Accounts)]
pub struct Record<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ SpoilsError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

// ---------------------------------------------------------------------------- events

#[event]
pub struct AuthoritySet {
    pub old: Pubkey,
    pub new: Pubkey,
}

#[event]
pub struct MatchRecorded {
    pub seq: u64,
    pub cycle_id: u64,
    pub shard: u8,
    pub match_hash: [u8; 32],
    pub humans: u16,
    pub mia: u16,
    pub ts: i64,
}

#[event]
pub struct BossKillRecorded {
    pub seq: u64,
    pub cycle_id: u64,
    pub boss_kind: u8,
    pub killer_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct RareExtractRecorded {
    pub seq: u64,
    pub cycle_id: u64,
    pub item_def_hash: [u8; 32],
    pub rarity: u8,
    pub owner_hash: [u8; 32],
    pub ts: i64,
}

#[error_code]
pub enum SpoilsError {
    #[msg("Signer is not allowed to do this")]
    Unauthorized,
    #[msg("Program data account does not belong to this program")]
    BadProgramData,
    #[msg("More MIA players than humans")]
    MiaExceedsHumans,
    #[msg("Rarity out of range")]
    BadRarity,
    #[msg("Counter overflow")]
    CounterOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{Discriminator, Event};

    #[test]
    fn sequence_numbers_start_at_one_and_count_up() {
        let mut c = 0u64;
        assert_eq!(next_seq(&mut c).unwrap(), 1);
        assert_eq!(next_seq(&mut c).unwrap(), 2);
        assert_eq!(c, 2);
        let mut full = u64::MAX;
        assert!(next_seq(&mut full).is_err());
        assert_eq!(full, u64::MAX);
    }

    #[test]
    fn mia_never_exceeds_humans() {
        assert!(check_match(0, 0).is_ok());
        assert!(check_match(4, 4).is_ok());
        assert!(check_match(3, 4).is_err());
    }

    #[test]
    fn rarity_is_common_to_legendary() {
        for r in 0..=MAX_RARITY {
            assert!(check_rarity(r).is_ok());
        }
        assert!(check_rarity(MAX_RARITY + 1).is_err());
    }

    #[test]
    fn authority_rotation_needs_the_current_or_the_upgrade_authority() {
        let cur = Pubkey::new_unique();
        let upg = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        assert!(may_set_authority(&cur, &cur, Some(upg)));
        assert!(may_set_authority(&upg, &cur, Some(upg)));
        assert!(!may_set_authority(&other, &cur, Some(upg)));
        assert!(!may_set_authority(&other, &cur, None));
    }

    /// The web encoder (apps/web/src/lib/chain/program.ts) builds instructions by hand: these are
    /// the first 8 bytes of sha256("global:<name>") / ("account:<Name>") / ("event:<Name>").
    #[test]
    fn discriminators_are_the_anchor_sha256_prefixes() {
        assert_eq!(instruction::RecordMatch::DISCRIMINATOR, [148, 41, 163, 203, 58, 251, 192, 228]);
        assert_eq!(instruction::RecordBossKill::DISCRIMINATOR, [40, 68, 167, 187, 140, 8, 194, 144]);
        assert_eq!(instruction::RecordRareExtract::DISCRIMINATOR, [238, 101, 140, 153, 75, 207, 223, 207]);
        assert_eq!(instruction::Initialize::DISCRIMINATOR, [175, 175, 109, 31, 13, 152, 155, 237]);
        assert_eq!(instruction::SetAuthority::DISCRIMINATOR, [133, 250, 37, 21, 110, 163, 26, 121]);
        assert_eq!(Config::DISCRIMINATOR, [155, 12, 170, 224, 30, 250, 204, 130]);
        assert_eq!(MatchRecorded::DISCRIMINATOR, [24, 16, 103, 141, 92, 206, 126, 192]);
        let ev = MatchRecorded { seq: 1, cycle_id: 2, shard: 0, match_hash: [7; 32], humans: 3, mia: 1, ts: 9 };
        // discriminator + u64 + u64 + u8 + [u8; 32] + u16 + u16 + i64
        assert_eq!(ev.data().len(), 8 + 8 + 8 + 1 + 32 + 2 + 2 + 8);
    }

    #[test]
    fn config_space_fits_the_fields() {
        assert_eq!(Config::INIT_SPACE, 32 + 8 * 3 + 1);
    }
}
