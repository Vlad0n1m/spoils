export function buildSignMessage(nonce: string) {
  return `snake.sol — Sign in\n\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}`;
}
