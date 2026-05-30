import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

declare const WebSocket: any;

const root = path.resolve(__dirname, "..");
const desktopDir = path.join(root, "apps", "desktop-app");
const runtimeDir = path.join(root, ".runtime", "desktop-ui-smoke");
const screenshotPath = path.join(runtimeDir, "desktop-ui-smoke.png");
const uiUrl = "http://127.0.0.1:5173";
const apiUrl = "http://localhost:3000";

type CdpResponse = {
  id?: number;
  result?: any;
  error?: { message?: string };
};

function npmCommand() {
  return "npm";
}

function cleanEnv(env: NodeJS.ProcessEnv) {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key && !key.includes("=") && typeof value === "string") {
      output[key] = value;
    }
  }
  return output;
}

function browserCandidates() {
  if (process.env.BROWSER_PATH) {
    return [process.env.BROWSER_PATH];
  }

  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ];
  }

  return ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"];
}

async function pathExists(candidate: string) {
  try {
    await import("node:fs/promises").then((fs) => fs.access(candidate));
    return true;
  } catch {
    return false;
  }
}

async function findBrowser() {
  for (const candidate of browserCandidates()) {
    if (path.isAbsolute(candidate)) {
      if (await pathExists(candidate)) {
        return candidate;
      }
    } else {
      return candidate;
    }
  }

  throw new Error("No supported Edge/Chrome browser found. Set BROWSER_PATH to run smoke:desktop-ui.");
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean } = {}
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: cleanEnv(options.env ?? process.env),
      stdio: "inherit",
      shell: options.shell ?? false
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

function spawnManaged(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean } = {}
) {
  return spawn(command, args, {
    cwd: options.cwd ?? root,
    env: cleanEnv(options.env ?? process.env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: options.shell ?? false
  });
}

async function waitForHttp(url: string, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function isHttpReady(url: string) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate TCP port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

class CdpClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private ws: any;

  constructor(private readonly wsUrl: string) {}

  connect() {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (event: any) => reject(new Error(`CDP WebSocket error: ${String(event?.message ?? event)}`));
      this.ws.onmessage = (event: any) => {
        const message = JSON.parse(String(event.data)) as CdpResponse;
        if (!message.id) {
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message ?? "CDP command failed"));
        } else {
          pending.resolve(message.result);
        }
      };
    });
  }

  send(method: string, params: Record<string, unknown> = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Timed out waiting for CDP method ${method}`));
        }
      }, 20_000);
    });
  }

  close() {
    this.ws?.close();
  }
}

async function openPage(browserPort: number, targetUrl: string) {
  const response = await fetch(
    `http://127.0.0.1:${browserPort}/json/new?${encodeURIComponent(targetUrl)}`,
    { method: "PUT" }
  );
  if (!response.ok) {
    throw new Error(`Failed to create browser tab: ${response.status}`);
  }
  const target = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!target.webSocketDebuggerUrl) {
    throw new Error("Browser tab did not expose a webSocketDebuggerUrl");
  }

  const page = new CdpClient(target.webSocketDebuggerUrl);
  await page.connect();
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  return page;
}

async function runUiFlow(page: CdpClient) {
  const expression = String.raw`
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (fn, message, timeoutMs = 60000) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          const value = fn();
          if (value) return value;
          await sleep(250);
        }
        throw new Error(message);
      };
      const setNativeValue = (element, value) => {
        const prototype = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        descriptor.set.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      };

      await waitFor(() => document.querySelector("#prompt"), "prompt field missing");

      const beforeJobIds = new Set(
        Array.from(document.querySelectorAll(".jobRow strong"))
          .map((node) => node.textContent?.trim() ?? "")
          .filter((text) => text.startsWith("JOB-"))
      );

      const prompt = document.querySelector("#prompt");
      const routingMode = document.querySelector("#routingMode");
      const maxModelCalls = document.querySelector("#maxModelCalls");
      const submitButton = Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent.trim() === "Start Job");

      setNativeValue(prompt, "Desktop UI smoke: create a cancellable mock job and show the timeline.");
      setNativeValue(routingMode, "supervisor_pipeline");
      setNativeValue(maxModelCalls, "20");
      submitButton.click();

      const jobId = await waitFor(() => {
        const rows = Array.from(document.querySelectorAll(".jobRow"));
        for (const row of rows) {
          const text = row.querySelector("strong")?.textContent?.trim() ?? "";
          if (text.startsWith("JOB-") && !beforeJobIds.has(text)) {
            row.click();
            return text;
          }
        }
        return "";
      }, "newly created job did not appear in list");

      await waitFor(() => document.body.textContent.includes(jobId), "created job was not selected");

      const cancelButton = await waitFor(() => {
        const button = document.querySelector(".dangerButton");
        return button && !button.disabled ? button : null;
      }, "cancel button was not enabled");
      cancelButton.click();

      await waitFor(() => {
        const text = document.body.textContent;
        return text.includes(jobId) && text.includes("cancelled");
      }, "job did not become cancelled", 90000);

      await waitFor(() => document.querySelectorAll(".timelineItem").length > 0, "timeline did not render");

      return {
        jobId,
        statusVisible: document.body.textContent.includes("cancelled"),
        timelineItems: document.querySelectorAll(".timelineItem").length,
        title: document.querySelector(".jobDetail h2")?.textContent?.trim() ?? ""
      };
    })()
  `;

  const result = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "UI flow failed");
  }

  return result.result.value as {
    jobId: string;
    statusVisible: boolean;
    timelineItems: number;
    title: string;
  };
}

async function main() {
  await mkdir(runtimeDir, { recursive: true });
  await rm(screenshotPath, { force: true });

  await run(npmCommand(), ["run", "dev:start"], {
    shell: process.platform === "win32",
    env: {
      ...process.env,
      FEISHU_ADAPTER_ENABLED: "false",
      FEISHU_DRY_RUN: "true",
      OPENCLAW_AGENT_MODE: "mock",
      AGENT_CLUSTER_CONFIG_PATH: ""
    }
  });

  let vite: ChildProcess | null = null;
  if (!(await isHttpReady(uiUrl))) {
    vite = spawnManaged(npmCommand(), ["run", "dev"], {
      cwd: desktopDir,
      shell: process.platform === "win32",
      env: {
        ...process.env,
        VITE_ORCHESTRATOR_URL: apiUrl
      }
    });
    vite.stdout?.on("data", (chunk) => process.stdout.write(chunk));
    vite.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  }

  const browserPort = await getFreePort();
  const browserPath = await findBrowser();
  const userDataDir = path.join(runtimeDir, "browser-profile");
  await rm(userDataDir, { recursive: true, force: true });

  const browser = spawnManaged(browserPath, [
    "--headless=new",
    "--disable-gpu",
    "--window-size=1440,980",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${browserPort}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ]);

  try {
    await waitForHttp(`http://127.0.0.1:${browserPort}/json/version`, 30_000);
    await waitForHttp(uiUrl, 60_000);

    const page = await openPage(browserPort, uiUrl);
    try {
      const flow = await runUiFlow(page);
      const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
      await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

      console.log(
        JSON.stringify(
          {
            ok: true,
            url: uiUrl,
            jobId: flow.jobId,
            statusVisible: flow.statusVisible,
            timelineItems: flow.timelineItems,
            screenshotPath,
            checked: [
              "desktop_ui_load",
              "create_job_from_ui",
              "job_list_selection",
              "cancel_job_from_ui",
              "timeline_rendered"
            ]
          },
          null,
          2
        )
      );
    } finally {
      page.close();
    }
  } finally {
    browser.kill();
    if (vite) {
      vite.kill();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
