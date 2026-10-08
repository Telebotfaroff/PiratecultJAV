import type { Telegraf } from 'telegraf';
import type { BotRole } from '../../config.ts';

let botInstance: Telegraf | null = null;
let isPollingActive = false;
let activeBotRole: BotRole = 'primary';

export function getBotInstance(): Telegraf | null {
  return botInstance;
}

export function setBotInstance(bot: Telegraf | null): void {
  botInstance = bot;
}

export function isPolling(): boolean {
  return isPollingActive;
}

export function setPollingActive(active: boolean): void {
  isPollingActive = active;
}

export function getActiveBotRole(): BotRole {
  return activeBotRole;
}

export function setActiveBotRole(role: BotRole): void {
  activeBotRole = role;
}
