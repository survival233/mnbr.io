/**
 * After demo boot: start Shopper + Traveler and stay running for Relay.
 * Shopper lives in apps/shopper-agent. Production Relay still hits
 * https://manebra-linq-agent.onrender.com until that cloud service is renamed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { initMarketplace, marketplacePath } from "./demo-marketplace.mts";

const C = { dim: "\x1b[2m", c: "\x1b[36m", x: "\x1b[0m" };

const require = createRequire(import.meta.url);

function repoRoot(): string {
  return fileURLToPath(new URL("../../..", import.meta.url));
}

function tsxCli(): string {
  return require.resolve("tsx/cli");
}

function envFileHasToken(rel: string): boolean {
  try {
    for (const line of readFileSync(new URL(rel, import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^RELAY_AGENT_TOKEN=(.*)$/);
      if (m && m[1]!.trim()) return true;
    }
  } catch {
    /* missing ok */
  }
  return false;
}

export async function startRelayHarness(args: {
  rpcUrl: string;
  usdcAddr: string;
  escrowAddr: string;
  attestorPrivateKey: string;
  anvilChild: ChildProcess | null;
}): Promise<void> {
  initMarketplace();
  const root = repoRoot();
  const extraEnv: NodeJS.ProcessEnv = {
    ...process.env,
    RPC_URL: args.rpcUrl,
    USDC_ADDRESS: args.usdcAddr,
    HANDOVER_ESCROW_ADDRESS: args.escrowAddr,
    ATTESTOR_PRIVATE_KEY: args.attestorPrivateKey,
    DEMO_LOCAL_CHAIN: "1",
    PAYMENT_MODE: "demo",
    DEMO_MARKETPLACE_PATH: marketplacePath(),
    DEMO_RELAY_POLL: "1",
    LINQ_DISABLED: "1",
  };
  // Product path is Relay-only — do not inherit iMessage routing from agent-cli/.env
  delete extraEnv.DEMO_TRANSPORT;
  delete extraEnv.LINQ_TO_PHONE;
  delete extraEnv.LINQ_FROM_PHONE;
  delete extraEnv.LINQ_CHAT_ID;
  delete extraEnv.LINQ_WEBHOOK_PORT;
  delete extraEnv.LINQ_WEBHOOK_SECRET;

  const children: ChildProcess[] = [];
  const start = (label: string, script: string, portEnv: Record<string, string>) => {
    const child = spawn(process.execPath, [tsxCli(), script], {
      cwd: root,
      env: { ...extraEnv, ...portEnv },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code, signal) => {
      console.log(`  ${C.dim}[${label}] exited code=${code} signal=${signal ?? ""}${C.x}`);
    });
    children.push(child);
    return child;
  };

  const shopperToken = envFileHasToken("../../shopper-agent/.env");
  const travelerToken = envFileHasToken("../../traveler-agent/.env");
  if (!shopperToken) {
    console.error(`${C.c}[relay]${C.x} Shopper RELAY_AGENT_TOKEN is missing in apps/shopper-agent/.env`);
    console.error(`  ${C.dim}Relay chat will hit the cloud agent — this local build will not see “yeah” or the new flow.${C.x}`);
  }
  if (!travelerToken) {
    console.error(`${C.c}[relay]${C.x} Traveler RELAY_AGENT_TOKEN is missing in apps/traveler-agent/.env`);
  }

  start("shopper", "apps/shopper-agent/src/main.mts", { PORT: "8790", SHOPPER_AGENT_PORT: "8790" });
  start("traveler", "apps/traveler-agent/src/main.mts", {
    PORT: "8791",
    TRAVELER_AGENT_PORT: "8791",
  });

  console.log(`${C.c}[relay]${C.x} Shopper :8790  Traveler :8791`);
  if (shopperToken && travelerToken) {
    console.log(`${C.c}[relay]${C.x} Open Relay and chat the two agents.`);
    console.log(`  ${C.dim}Shopper: describe what you want from the US.${C.x}`);
    console.log(`  ${C.dim}Traveler: accept or decline. Shopper funds only after accept.${C.x}`);
  } else {
    console.log(`${C.c}[relay]${C.x} Local agents are up, but Relay is not wired — add the missing token(s) and restart.`);
  }
  console.log(`  ${C.dim}Ctrl+C stops agents + local chain.${C.x}\n`);

  const shutdown = () => {
    for (const c of children) {
      try {
        c.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    if (args.anvilChild) {
      try {
        args.anvilChild.kill();
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>(() => {
    /* stay running */
  });
}
