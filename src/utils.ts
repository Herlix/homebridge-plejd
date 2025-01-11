export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Set a timeout for a function
 * @param operation - The function to run
 * @param timeoutMs - The timeout in milliseconds (default 5000)
 */
export const race = async <T>(
  operation: () => Promise<T>,
  timeoutMs = 5000,
): Promise<T> => {
  return Promise.race([
    operation(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("BLE operation timeout")), timeoutMs),
    ),
  ]);
};
