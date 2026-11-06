// Plain script with no AI. In GitHub Actions it holds the game FTP login and
// nothing else, and that account can only reach the game subdomain's folder.
import { existsSync, readFileSync } from "node:fs";
import { Client } from "basic-ftp";

type Target = { host: string; user: string; password: string; dir: string };

// Hostinger's FTP certificate names this host, whichever FTP address you connect to.
const HOSTINGER_CERT_HOST = "ftp.hstgr.io";

const OTHER_SITE_FOLDERS = ["delve", "public_html"];

function target(prefix: "GAME" | "VOTE"): Target {
  const read = (name: string) => {
    const value = process.env[`${prefix}_FTP_${name}`];
    if (!value) throw new Error(`Missing ${prefix}_FTP_${name}`);
    return value;
  };
  return {
    host: read("HOST").replace(/^ftps?:\/\//, ""),
    user: read("USER"),
    password: read("PASSWORD"),
    dir: process.env[`${prefix}_FTP_DIR`] || "/",
  };
}

async function withFtp(t: Target, work: (ftp: Client) => Promise<void>) {
  const ftp = new Client(60_000);
  try {
    await ftp.access({
      host: t.host,
      user: t.user,
      password: t.password,
      secure: true,
      secureOptions: { servername: process.env.FTP_CERT_HOST ?? HOSTINGER_CERT_HOST },
    });
    await ftp.ensureDir(t.dir);
    // A wrongly scoped account would overwrite the main site, so stop before uploading.
    const names = (await ftp.list()).map((item) => item.name.toLowerCase());
    const foreign = names.filter((name) => OTHER_SITE_FOLDERS.includes(name));
    if (foreign.length) throw new Error(`This FTP account can reach ${foreign.join(", ")}. Limit it to its own folder.`);
    await work(ftp);
  } finally {
    ftp.close();
  }
}

function loadEnvFile() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

async function deployGame(dir: string, version: string) {
  if (!/^v\d+$/.test(version)) throw new Error("Version must look like v12.");
  const t = target("GAME");
  await withFtp(t, async (ftp) => {
    const root = await ftp.pwd();
    await ftp.uploadFrom("sandbox-host/.htaccess", ".htaccess");
    // The archive copy goes first, so a failed upload can't touch the live game.
    // The save file goes last each time, so a game file can never replace it.
    await ftp.ensureDir(`${root}/${version}`);
    await ftp.uploadFromDir(dir);
    await ftp.uploadFrom("sandbox-host/account-save.js", "account-save.js");
    await ftp.cd(root);
    await ftp.uploadFromDir(dir);
    await ftp.uploadFrom("sandbox-host/account-save.js", "account-save.js");
  });
  console.log(`Published ${version}.`);
}

async function deployLink() {
  await withFtp(target("GAME"), async (ftp) => {
    await ftp.uploadFrom("sandbox-host/account-save.js", "account-save.js");
  });
  console.log("Published the game link.");
}

async function deployShell() {
  loadEnvFile();
  await withFtp(target("VOTE"), async (ftp) => {
    await ftp.uploadFromDir("dist/shell");
  });
  console.log("Published the voting site.");
}

const args = process.argv.slice(2);
if (args[0] === "--shell") await deployShell();
else if (args[0] === "--game") await deployGame(args[1], args[2]);
else if (args[0] === "--link") await deployLink();
else throw new Error("Usage: deploy.ts --shell | --link | --game <dir> <version>");
