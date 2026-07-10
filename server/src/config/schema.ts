import { z } from "zod";

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  real_name: z.string().optional(),
  is_bot: z.boolean().optional().default(false),
  email: z.string().optional(),
  tz: z.string().optional().default("America/Los_Angeles"),
});

export const ChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  is_channel: z.boolean().optional().default(true),
  is_private: z.boolean().optional().default(false),
  is_im: z.boolean().optional().default(false),
  topic: z.string().optional().default(""),
  purpose: z.string().optional().default(""),
  members: z.array(z.string()).default([]),
});

export const AppSchema = z.object({
  appId: z.string().default("A01APP"),
  botUserId: z.string().default("U0BOT"),
  botName: z.string().default("bot"),
  botToken: z.string().default("xoxb-test-token"),
  appToken: z.string().default("xapp-test-token"),
  signingSecret: z.string().default("test-signing-secret"),
  mode: z.enum(["socket", "events"]).default("socket"),
  requestUrl: z.string().optional(),
});

export const WorkspaceSchema = z.object({
  name: z.string().default("Test Workspace"),
  domain: z.string().default("test-workspace"),
  teamId: z.string().default("T01TEST"),
});

export const ConfigSchema = z
  .object({
    workspace: WorkspaceSchema.default({}),
    // One workspace can host multiple apps/bots under test at once (e.g. testing bot-to-bot
    // interaction, or two apps sharing a workspace). `config/load.ts` accepts a legacy
    // singular `app:` key and normalizes it to `apps: [app]` before this schema ever sees it.
    apps: z.array(AppSchema).min(1).default([{}]),
    users: z.array(UserSchema).default([]),
    channels: z.array(ChannelSchema).default([]),
    // Custom emoji name -> image path (resolved relative to the config file's
    // directory by config/load.ts, which also rewrites this to an absolute path).
    emojis: z.record(z.string(), z.string()).default({}),
  })
  .refine((c) => new Set(c.apps.map((a) => a.appId)).size === c.apps.length, {
    message: "apps[].appId must be unique across all configured apps",
    path: ["apps"],
  })
  .refine((c) => new Set(c.apps.map((a) => a.botUserId)).size === c.apps.length, {
    message: "apps[].botUserId must be unique across all configured apps",
    path: ["apps"],
  })
  .refine((c) => new Set(c.apps.map((a) => a.botToken)).size === c.apps.length, {
    message: "apps[].botToken must be unique across all configured apps",
    path: ["apps"],
  });

export type Config = z.infer<typeof ConfigSchema>;
export type UserConfig = z.infer<typeof UserSchema>;
export type ChannelConfig = z.infer<typeof ChannelSchema>;
export type AppConfig = z.infer<typeof AppSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceSchema>;
