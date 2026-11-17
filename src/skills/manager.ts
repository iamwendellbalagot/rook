import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const execFile = promisify(execFileCallback);

export type SkillScope = "project" | "global";

export interface InstalledSkill {
  name: string;
  description: string;
  scope: SkillScope;
  path: string;
}

export function getRookSkillDirectories(cwd = process.cwd()): {
  project: string;
  global: string;
} {
  return {
    project: resolve(cwd, ".rook", "skills"),
    global: resolve(
      process.env.ROOK_HOME || join(homedir(), ".rook"),
      "skills",
    ),
  };
}

export function isWithinDirectory(path: string, directory: string): boolean {
  const pathFromRoot = relative(resolve(directory), resolve(path));
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

export function isWithinRookSkillDirectories(
  path: string,
  directories: string[],
): boolean {
  try {
    const realPath = realpathSync(path);
    return directories.some((directory) => {
      try {
        if (lstatSync(directory).isSymbolicLink()) return false;
        return isWithinDirectory(realPath, realpathSync(directory));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export async function listInstalledSkills(
  cwd = process.cwd(),
): Promise<InstalledSkill[]> {
  const directories = getRookSkillDirectories(cwd);
  const installed: InstalledSkill[] = [];
  for (const scope of ["project", "global"] as const) {
    const { skills } = loadSkillsFromDir({
      dir: directories[scope],
      source: `rook-${scope}`,
    });
    installed.push(
      ...skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        scope,
        path: skill.baseDir,
      })),
    );
  }
  return installed;
}

export async function installSkills(
  source: string,
  options: {
    cwd?: string;
    scope?: SkillScope;
    skillName?: string;
  } = {},
): Promise<InstalledSkill[]> {
  const cwd = options.cwd ?? process.cwd();
  const scope = options.scope ?? "project";
  const directories = getRookSkillDirectories(cwd);
  const targetRoot = directories[scope];
  const localSource = resolve(
    cwd,
    source.startsWith("~/") ? join(homedir(), source.slice(2)) : source,
  );
  const hasLocalSource = await pathExists(localSource);
  const gitSource = hasLocalSource ? undefined : parseGitSource(source);
  const temporaryRoot = gitSource
    ? await mkdtemp(join(tmpdir(), "rook-skill-source-"))
    : undefined;

  try {
    let skillsRoot: string;
    if (gitSource) {
      const checkout = join(temporaryRoot!, "checkout");
      const args = ["clone", "--depth", "1"];
      if (gitSource.ref) args.push("--branch", gitSource.ref);
      args.push("--", gitSource.url, checkout);
      await execFile("git", args, {
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_LFS_SKIP_SMUDGE: "1",
        },
      });
      skillsRoot = gitSource.subdirectory
        ? resolve(checkout, gitSource.subdirectory)
        : checkout;
      if (!isWithinDirectory(skillsRoot, checkout)) {
        throw new Error(
          "The requested skill path escapes the cloned repository.",
        );
      }
      await access(skillsRoot);
    } else {
      skillsRoot = localSource;
      await access(skillsRoot);
    }

    const skillDirectories = loadSkillsFromDir({
      dir: skillsRoot,
      source: gitSource ? source : "local",
    }).skills.filter((skill) => basename(skill.filePath) === "SKILL.md");
    const selected = options.skillName
      ? skillDirectories.filter((skill) => skill.name === options.skillName)
      : skillDirectories;
    if (!selected.length) {
      throw new Error(
        options.skillName
          ? `No skill named '${options.skillName}' was found in ${source}.`
          : `No valid SKILL.md files were found in ${source}.`,
      );
    }

    await mkdir(targetRoot, { recursive: true, mode: 0o700 });
    const plans = selected.map((skill) => {
      const directoryName = safeSkillDirectoryName(skill.name);
      return {
        skill,
        directoryName,
        destination: join(targetRoot, directoryName),
      };
    });
    if (
      new Set(plans.map(({ directoryName }) => directoryName)).size !==
      plans.length
    ) {
      throw new Error(
        "The source contains multiple skills with the same name.",
      );
    }
    for (const { skill, destination } of plans) {
      let destinationExists = true;
      try {
        await lstat(destination);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
          destinationExists = false;
        else throw error;
      }
      if (destinationExists) {
        throw new Error(
          `Skill '${skill.name}' is already installed in ${scope} scope. Remove it first to replace it.`,
        );
      }
    }

    const stagingRoot = await mkdtemp(join(targetRoot, ".rook-skill-install-"));
    const installed: string[] = [];
    try {
      const canonicalSkillsRoot = await realpath(skillsRoot);
      for (const { skill, directoryName } of plans) {
        const canonicalSkillRoot = await realpath(skill.baseDir);
        if (!isWithinDirectory(canonicalSkillRoot, canonicalSkillsRoot)) {
          throw new Error(
            "Skill content resolves outside the selected source directory.",
          );
        }
        await copySkillTree(skill.baseDir, join(stagingRoot, directoryName));
      }
      for (const { destination, directoryName } of plans) {
        await rename(join(stagingRoot, directoryName), destination);
        installed.push(destination);
      }
    } catch (error) {
      await Promise.all(
        installed.map((directory) =>
          rm(directory, { recursive: true, force: true }),
        ),
      );
      throw error;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
    return plans.map(({ skill, destination }) => ({
      name: skill.name,
      description: skill.description,
      scope,
      path: destination,
    }));
  } finally {
    if (temporaryRoot)
      await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function removeInstalledSkill(
  name: string,
  options: { cwd?: string; scope?: SkillScope } = {},
): Promise<boolean> {
  const directories = getRookSkillDirectories(options.cwd ?? process.cwd());
  const scope = options.scope ?? "project";
  const matches = loadSkillsFromDir({
    dir: directories[scope],
    source: `rook-${scope}`,
  }).skills.filter((skill) => skill.name === name);
  if (!matches.length) return false;
  for (const skill of matches) {
    if (!isWithinDirectory(skill.baseDir, directories[scope])) {
      throw new Error(
        "Refusing to remove a skill outside Rook's managed directory.",
      );
    }
    if (resolve(skill.baseDir) === resolve(directories[scope])) {
      throw new Error(
        "Refusing to remove a skill stored at the root of Rook's skills directory.",
      );
    }
    await rm(skill.baseDir, { recursive: true, force: false });
  }
  return true;
}

export function parseGitSource(
  source: string,
): { url: string; ref?: string; subdirectory?: string } | undefined {
  const githubShorthand = source.match(
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([^/]+))?$/,
  );
  if (githubShorthand) {
    const [, owner, repository, ref] = githubShorthand;
    return {
      url: `https://github.com/${owner}/${repository!.replace(/\.git$/, "")}.git`,
      ...(ref ? { ref } : {}),
    };
  }

  if (/^git@[^:]+:[^/]+\/.+/.test(source) || /^ssh:\/\//i.test(source)) {
    return { url: source };
  }

  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Git skill sources must use HTTPS or SSH.");
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    parsed.hostname.toLowerCase() === "github.com" &&
    segments[2] === "tree"
  ) {
    if (segments.length < 4)
      throw new Error("The GitHub skill URL is incomplete.");
    const [owner, repository, , encodedRef, ...subdirectory] = segments;
    return {
      url: `https://github.com/${owner}/${repository!.replace(/\.git$/, "")}.git`,
      ref: decodeURIComponent(encodedRef!),
      ...(subdirectory.length
        ? { subdirectory: subdirectory.map(decodeURIComponent).join("/") }
        : {}),
    };
  }
  if (parsed.protocol === "http:") {
    throw new Error("Git skill sources must use HTTPS or SSH.");
  }
  return { url: source };
}

async function copySkillTree(
  source: string,
  destination: string,
): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(`Skill root must be a real directory: ${source}`);
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Skill contains a symbolic link: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      await copySkillTree(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, destinationPath);
    } else {
      throw new Error(
        `Skill contains an unsupported filesystem entry: ${sourcePath}`,
      );
    }
  }
}

function safeSkillDirectoryName(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error(
      `Skill name '${name}' is not a safe folder name (use lowercase letters, numbers, dots, underscores, or hyphens).`,
    );
  }
  return name;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
