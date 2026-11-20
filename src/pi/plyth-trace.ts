import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseTraceRecord, type TraceRecord } from "plyth";

const MAX_BYTES = 64 * 1024;

/** Opt-in, bounded, private JSONL. All failures stay local and never stop a tool. */
export class PlythTraceStore {
  private enabled: boolean;
  private dropped = 0;
  private error = false;
  readonly directory: string;
  readonly file: string;

  constructor(
    enabled = false,
    root = process.env.ROOK_HOME || join(homedir(), ".rook"),
  ) {
    this.enabled = enabled;
    this.directory = join(resolve(root), "plyth");
    this.file = join(this.directory, "trace.jsonl");
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  append(record: TraceRecord): void {
    if (!this.enabled) return;
    let fd: number | undefined;
    let lock: number | undefined;
    try {
      const safeRecord = parseTraceRecord(record);
      if (!safeRecord) throw new Error("invalid_record");
      this.checkDirectory(true);
      lock = openSync(
        join(this.directory, "append.lock"),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      fd = openSync(
        this.file,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NONBLOCK |
          constants.O_NOFOLLOW,
        0o600,
      );
      const size = this.checkFile(fd);
      const line = JSON.stringify(safeRecord) + "\n";
      if (size + Buffer.byteLength(line) > MAX_BYTES) {
        this.dropped++;
        return;
      }
      const buffer = Buffer.from(line);
      let written = 0;
      while (written < buffer.length) {
        const count = writeSync(fd, buffer, written, buffer.length - written);
        if (count === 0) throw new Error("write_failed");
        written += count;
      }
    } catch {
      this.error = true;
      this.dropped++;
    } finally {
      this.close(fd);
      if (lock !== undefined) {
        this.close(lock);
        try {
          unlinkSync(join(this.directory, "append.lock"));
        } catch {
          this.error = true;
        }
      }
    }
  }

  status(): string {
    return `PLYTH traces ${this.enabled ? "on" : "off"} · limit ${MAX_BYTES} bytes · dropped ${this.dropped}${this.error ? " · storage unavailable" : ""}\nLocal file: ${this.file}`;
  }

  export(): string {
    let fd: number | undefined;
    try {
      if (!this.checkDirectory(false)) return "No PLYTH trace records.";
      fd = openSync(
        this.file,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      if (this.checkFile(fd) > MAX_BYTES) throw new Error("oversized_trace");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes > MAX_BYTES) throw new Error("oversized_trace");
      const data = buffer.subarray(0, bytes).toString("utf8");
      const records = data
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const record = parseTraceRecord(JSON.parse(line));
          if (!record) throw new Error("invalid_trace");
          return JSON.stringify(record);
        });
      return records.join("\n") || "No PLYTH trace records.";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return "No PLYTH trace records.";
      this.error = true;
      return "PLYTH trace export unavailable; no raw records exported.";
    } finally {
      this.close(fd);
    }
  }

  clear(): string {
    this.enabled = false;
    let fd: number | undefined;
    try {
      if (this.checkDirectory(false)) {
        fd = openSync(
          this.file,
          constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
        this.checkFile(fd);
        closeSync(fd);
        fd = undefined;
        unlinkSync(this.file);
      }
      this.dropped = 0;
      this.error = false;
      return "PLYTH traces cleared and tracing disabled.";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.dropped = 0;
        this.error = false;
        return "PLYTH traces cleared and tracing disabled.";
      }
      this.error = true;
      return "PLYTH tracing disabled; trace deletion unavailable.";
    } finally {
      this.close(fd);
    }
  }

  private checkDirectory(create: boolean): boolean {
    if (
      typeof constants.O_NOFOLLOW !== "number" ||
      constants.O_NOFOLLOW <= 0 ||
      typeof process.getuid !== "function"
    )
      throw new Error("safe_file_access_unavailable");
    const root = resolve(this.directory, "..");
    if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      const parent = lstatSync(root);
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        (process.getuid && parent.uid !== process.getuid())
      )
        throw new Error("unsafe_root");
      if (create) {
        try {
          mkdirSync(this.directory, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const directory = lstatSync(this.directory);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (process.getuid &&
          (directory.uid !== process.getuid() ||
            (directory.mode & 0o077) !== 0))
      )
        throw new Error("unsafe_directory");
      return true;
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT")
        return false;
      throw error;
    }
  }

  private checkFile(fd: number): number {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.getuid &&
        (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
    )
      throw new Error("unsafe_file");
    return stat.size;
  }

  private close(fd: number | undefined): void {
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {
      this.error = true;
    }
  }
}
