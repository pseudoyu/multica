/**
 * Async Operation Serialization
 *
 * Prevents concurrent operations from corrupting files by serializing
 * operations that share the same key.
 *
 * Inspired by OpenClaw's serialize.ts pattern.
 */

// ============================================================================
// Types
// ============================================================================

type AsyncOperation<T> = () => Promise<T>;

interface QueuedOperation {
  operation: AsyncOperation<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

// ============================================================================
// Serialization Queue
// ============================================================================

/**
 * Global map of operation queues keyed by identifier
 */
const operationQueues = new Map<string, QueuedOperation[]>();

/**
 * Set of keys currently being processed
 */
const processingKeys = new Set<string>();

/**
 * Process the next operation in the queue for a given key
 */
async function processQueue(key: string): Promise<void> {
  // If already processing this key, return
  if (processingKeys.has(key)) {
    return;
  }

  const queue = operationQueues.get(key);
  if (!queue || queue.length === 0) {
    operationQueues.delete(key);
    return;
  }

  processingKeys.add(key);

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;

    try {
      const result = await item.operation();
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    }
  }

  processingKeys.delete(key);
  operationQueues.delete(key);
}

/**
 * Serialize an async operation by key
 *
 * Operations with the same key will be executed sequentially,
 * preventing race conditions and file corruption.
 *
 * @param key - Unique identifier for the operation group
 * @param operation - Async operation to execute
 * @returns Promise resolving to the operation result
 *
 * @example
 * ```typescript
 * // Multiple concurrent calls to the same skill will be serialized
 * await serialize('skill:pdf', async () => {
 *   await writeFile(path, content);
 *   return parseSkillFile(path);
 * });
 * ```
 */
export function serialize<T>(key: string, operation: AsyncOperation<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let queue = operationQueues.get(key);
    if (!queue) {
      queue = [];
      operationQueues.set(key, queue);
    }

    queue.push({
      operation: operation as AsyncOperation<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
    });

    // Start processing if not already processing
    void processQueue(key);
  });
}

/**
 * Create a serialized version of an async function
 *
 * @param keyFn - Function to generate key from arguments
 * @param fn - Async function to wrap
 * @returns Serialized version of the function
 *
 * @example
 * ```typescript
 * const serializedAddSkill = createSerialized(
 *   (req) => `skill:${req.name ?? 'default'}`,
 *   addSkill
 * );
 * ```
 */
export function createSerialized<TArgs extends unknown[], TResult>(
  keyFn: (...args: TArgs) => string,
  fn: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => {
    const key = keyFn(...args);
    return serialize(key, () => fn(...args));
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if an operation key is currently being processed
 */
export function isProcessing(key: string): boolean {
  return processingKeys.has(key);
}

/**
 * Get the number of queued operations for a key
 */
export function getQueueLength(key: string): number {
  return operationQueues.get(key)?.length ?? 0;
}

/**
 * Get all currently active operation keys
 */
export function getActiveKeys(): string[] {
  return Array.from(processingKeys);
}

/**
 * Wait for all operations for a key to complete
 */
export async function waitForKey(key: string): Promise<void> {
  if (!processingKeys.has(key)) {
    return;
  }

  // Create a dummy operation that resolves immediately
  // It will be queued after all current operations
  return serialize(key, async () => {});
}

/**
 * Wait for all pending operations to complete
 */
export async function waitForAll(): Promise<void> {
  const keys = Array.from(processingKeys);
  await Promise.all(keys.map((key) => waitForKey(key)));
}

// ============================================================================
// Serialization Keys
// ============================================================================

/**
 * Standard serialization key generators for common operations
 */
export const SerializeKeys = {
  /**
   * Key for skill add operations
   */
  skillAdd: (name: string) => `skill:add:${name}`,

  /**
   * Key for skill remove operations
   */
  skillRemove: (name: string) => `skill:remove:${name}`,

  /**
   * Key for skill install operations
   */
  skillInstall: (skillId: string) => `skill:install:${skillId}`,

  /**
   * Key for managed skills directory operations
   */
  managedSkills: () => "skills:managed",

  /**
   * Key for any file path operations
   */
  file: (path: string) => `file:${path}`,
} as const;
