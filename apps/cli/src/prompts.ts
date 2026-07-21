import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function promptText(label: string, options: { required?: boolean } = { required: true }): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const value = (await readline.question(`${label}: `)).trim();
      if (value || options.required === false) return value;
      stdout.write("A value is required.\n");
    }
  } finally {
    readline.close();
  }
}

export async function choose<T extends string>(label: string, choices: readonly T[]): Promise<T> {
  if (choices.length === 0) throw new Error("No choices are available");
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`\n${label}\n`);
    choices.forEach((choice, index) => stdout.write(`  ${index + 1}. ${choice}\n`));
    while (true) {
      const answer = Number.parseInt((await readline.question("Select: ")).trim(), 10);
      const choice = choices[answer - 1];
      if (choice !== undefined) return choice;
      stdout.write("Choose one of the listed numbers.\n");
    }
  } finally {
    readline.close();
  }
}

export async function confirm(label: string): Promise<boolean> {
  const answer = await promptText(`${label} [y/N]`, { required: false });
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}
