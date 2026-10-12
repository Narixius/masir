// citty keeps only the last value of a repeated flag (`--domain a --domain b`
// gives "b"), so repeatable flags are read from the raw argv instead.

/** Every value given for `--<name>` (as `--name value` or `--name=value`), in order. */
export const collectFlag = (rawArgs: readonly string[], name: string): string[] => {
  const flag = `--${name}`;
  const values: string[] = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i] as string;
    if (token === flag) {
      const value = i + 1 < rawArgs.length ? (rawArgs[i + 1] as string) : undefined;
      if (value !== undefined && !value.startsWith("--")) {
        values.push(value);
        i += 1;
      }
    } else if (token.startsWith(`${flag}=`)) {
      values.push(token.slice(flag.length + 1));
    }
  }
  return values;
};

/**
 * Values split on commas too (`--ip 1.1.1.1,8.8.8.8`), except where a comma
 * can be part of the value (`regexp:a{1,3}`).
 */
export const splitList = (values: readonly string[], keepWhole: (value: string) => boolean = () => false): string[] => {
  const items: string[] = [];
  for (const value of values) {
    const parts = keepWhole(value) ? [value] : value.split(",");
    for (const part of parts) {
      const item = part.trim();
      if (item.length > 0) {
        items.push(item);
      }
    }
  }
  return items;
};
