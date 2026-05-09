const RECENT_MAX = 6;
export const recentByChat = new Map();
export const lastBotRepliesByChat = new Map();
export function pushRecent(chatId, sender, text) {
    const arr = recentByChat.get(chatId) ?? [];
    arr.push({ sender, text });
    while (arr.length > RECENT_MAX)
        arr.shift();
    recentByChat.set(chatId, arr);
}
export function getPriors(chatId) {
    const arr = recentByChat.get(chatId) ?? [];
    return arr.slice(0, -1).slice(-5);
}
