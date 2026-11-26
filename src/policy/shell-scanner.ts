export interface ShellScan {
  commands: string[];
  paths: string[];
  complete: boolean;
}

/** Conservative POSIX subset. This is approval routing, NOT process isolation. */
export function scanShell(command: string): ShellScan {
  const commands: string[] = [];
  const paths: string[] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  let complete = true;
  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endCommand = () => {
    endWord();
    if (!words.length) return;
    if (
      /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|!|time|coproc|eval|exec|source|\.|bash|sh|zsh|env|command|builtin|xargs|find|sudo|su|nohup|setsid|timeout)$/.test(
        words[0]!,
      ) ||
      words.some((value) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(value))
    )
      complete = false;
    commands.push(words.join(" "));
    for (const value of words.slice(1)) {
      const candidate = value.replace(/^--?[\w-]+=/, "");
      if (/^(?:\/|~(?:\/|$)|\.\.(?:\/|$))/.test(candidate))
        paths.push(candidate);
    }
    // cd changes interpretation of all later relative paths; ask for the full command.
    if (words[0] === "cd") complete = false;
    words = [];
  };
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (character === "\\" && quote !== "'") {
      if (index + 1 >= command.length) {
        complete = false;
        break;
      }
      const next = command[++index]!;
      if (next === "\n") {
        complete = false;
        continue;
      }
      word += next;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else {
        if (quote === '"' && /[$`]/.test(character)) complete = false;
        word += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (character === "\n") endCommand();
      else endWord();
    } else if (/[;&|]/.test(character)) {
      if (
        character === "&" &&
        command[index + 1] !== "&" &&
        command[index - 1] !== "&"
      )
        complete = false;
      endCommand();
    } else {
      if (/[$`<>(){}*?\[\]#]/.test(character)) complete = false;
      word += character;
      started = true;
    }
  }
  if (quote) complete = false;
  endCommand();
  return {
    commands,
    paths: [...new Set(paths)],
    complete: complete && commands.length > 0,
  };
}
