// Runs the backend (Bun, watch mode) and the Vite dev server together.
// The Vite dev server proxies /api, /socket, /_control and /ui to the backend (see web/vite.config.ts).
const procs: { name: string; cmd: string[]; cwd: string }[] = [
  {
    name: "server",
    cmd: ["bun", "--watch", "src/cli.ts", "--config", "../examples/config.yaml", "--port", "3000"],
    cwd: "server",
  },
  { name: "web", cmd: ["bun", "run", "dev"], cwd: "web" },
];

const children = procs.map((p) =>
  Bun.spawn(p.cmd, { cwd: p.cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" }),
);

const shutdown = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all(children.map((c) => c.exited));
