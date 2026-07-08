import { Blocks } from "../blockkit/BlockKit.tsx";
import { sendBlockAction } from "../client.ts";

// Renders the bot's published App Home view for the acting user.
export function HomeTab({
  view,
  botName,
  actingUser,
}: {
  view: any | undefined;
  botName: string;
  actingUser: string;
}) {
  // App Home actions have no container message; deliver a block_action with an empty ts.
  const onAction = (action: any) => sendBlockAction("", "", actingUser, action);

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
