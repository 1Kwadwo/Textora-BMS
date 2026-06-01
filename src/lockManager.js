const fs = require('fs').promises
const path = require('path')

const locksDir = path.join(__dirname, '..', 'locks')

async function ensureLocksDir() {
  try {
    await fs.mkdir(locksDir, { recursive: true })
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err
    }
  }
}

async function isLockStale(lockPath, timeoutMs = 60000) {
  try {
    const data = await fs.readFile(lockPath, 'utf8')
    const metadata = JSON.parse(data)
    if (metadata && metadata.timestamp) {
      const age = Date.now() - Number(metadata.timestamp)
      return age > timeoutMs
    }
  } catch (err) {
    // If we can't read/parse, assume it is not stale or handle carefully
  }
  return false
}

async function acquireLock(lockName, timeoutMs = 15000, retryIntervalMs = 50, lockExpiryMs = 60000) {
  await ensureLocksDir()
  const lockPath = path.join(locksDir, `${lockName}.lock`)
  const start = Date.now()

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx')
      const metadata = {
        pid: process.pid,
        timestamp: Date.now()
      }
      await handle.writeFile(JSON.stringify(metadata), 'utf8')
      await handle.close()
      return lockPath
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Check if the existing lock is stale
        const stale = await isLockStale(lockPath, lockExpiryMs)
        if (stale) {
          console.log(`Lock ${lockName} is stale. Cleaning up...`)
          try {
            await fs.unlink(lockPath)
            // Retry immediately after cleanup
            continue
          } catch (unlinkErr) {
            if (unlinkErr.code !== 'ENOENT') {
              // Ignore if deleted by another process concurrently
            }
          }
        }
      } else {
        throw err
      }
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`Lock acquisition timed out for lock name: ${lockName}`)
    }

    await new Promise(resolve => setTimeout(resolve, retryIntervalMs))
  }
}

async function releaseLock(lockPath) {
  try {
    await fs.unlink(lockPath)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err
    }
  }
}

async function withLock(lockName, fn, timeoutMs = 15000) {
  const lockPath = await acquireLock(lockName, timeoutMs)
  try {
    return await fn()
  } finally {
    await releaseLock(lockPath)
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  withLock
}
