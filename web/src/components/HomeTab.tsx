import { Blocks } from "../blockkit/BlockKit.tsx";
import { sendBlockAction } from "../client.ts";

// Renders a specific app's published App Home view for the acting user.
export function HomeTab({
  appId,
  view,
  botName,
  actingUser,
}: {
  appId: string;
  view: any | undefined;
  botName: string;
  actingUser: string;
}) {
  // App Home actions have no container message; deliver a block_action with an empty ts,
  // but an explicit appId since there's no message to infer which app it's for.
  const onAction = (action: any) => sendBlockAction("", "", actingUser, action, appId);

  return (
    <div className="home">
      <div className="home-inner">
        {view ? (
          <Blocks blocks={view.blocks} ctx={{ onAction }} />
        ) : (
          <div className="empty">Opening {botName}'s Home tab…</div>
        )}
      </div>
    </div>
  );
}
