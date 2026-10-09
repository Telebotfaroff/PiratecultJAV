export type BotRole = 'primary' | 'backup';

let activeBotRole: BotRole = 'primary';

/** Returns the bot role currently selected by the runtime. */
export function getActiveBotRole(): BotRole {
  return activeBotRole;
}

/** Updates the shared role used by runtime handlers and helper modules. */
export function setActiveBotRole(role: BotRole): void {
  activeBotRole = role;
}
