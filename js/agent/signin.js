// agent/signin.js — is a failed Claude Code or Codex turn a sign-in problem, and what to run about it. No browser or
// Node APIs: the local server and the agent panel both use it.
const PATTERN = {
  claude: /failed to authenticate|oauth session expired|not logged in|please run \/login/i,
  codex: /could not be refreshed|sign in again|401 unauthorized|not logged in/i,
};
export const needsSignIn = (agent, error) => !!PATTERN[agent]?.test(String(error || ''));
export const SIGN_IN_COMMAND = { claude: 'claude auth login', codex: 'codex login' };
// the browser is on another computer: the CLI's callback to localhost cannot reach it (Claude Code has no device flow)
export const REMOTE_SIGN_IN_COMMAND = { claude: 'claude auth login', codex: 'codex login --device-auth' };
