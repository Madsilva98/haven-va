import type { Context } from "grammy";

import { log } from "../lib/log.js";
import * as notion from "../notion.js";
import type { ChatContext, CreateEntityIntent } from "../types.js";

const KIND_EMOJI: Record<CreateEntityIntent["kind"], string> = {
  projeto: "📁",
  evento: "📅",
  parceria: "🤝",
  influencer: "📱",
};

const KIND_LABEL: Record<CreateEntityIntent["kind"], string> = {
  projeto: "projeto",
  evento: "evento",
  parceria: "parceria",
  influencer: "influencer",
};

export async function handleCreateEntity(
  ctx: Context,
  chatCtx: ChatContext,
  intent: CreateEntityIntent,
): Promise<void> {
  const { kind, nome, owner } = intent;
  const emoji = KIND_EMOJI[kind];
  const label = KIND_LABEL[kind];

  let pageId: string;
  try {
    switch (kind) {
      case "projeto":
        pageId = await notion.createProject(nome, owner);
        break;
      case "evento":
        pageId = await notion.createEvent(nome, owner);
        break;
      case "parceria":
        pageId = await notion.createPartner(nome, owner);
        break;
      case "influencer":
        pageId = await notion.createInfluencer(nome, owner);
        break;
    }
  } catch (err) {
    log.error("create_entity.failed", { kind, nome, err: String(err) });
    await ctx.reply(`erro a criar ${label} — tenta outra vez`);
    return;
  }

  void pageId;
  const ownerLine = owner === "Unassigned" ? "" : ` · ${owner}`;
  await ctx.reply(
    `${emoji} ${label} criado\n\n<b>${nome}</b>${ownerLine}`,
    { parse_mode: "HTML" },
  );
  log.info("create_entity.done", { kind, nome, owner, sender: chatCtx.sender });
}
