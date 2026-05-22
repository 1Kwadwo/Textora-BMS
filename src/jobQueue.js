function createJobQueue({ maxRetries = 3 } = {}) {
  const jobs = []

  function enqueue(job) {
    jobs.push({
      attempts: 0,
      ...job
    })
  }

  async function processNext(handler) {
    const job =
      jobs.shift()

    if (!job) {
      return null
    }

    try {
      job.attempts += 1
      await handler(job)
      return {
        job,
        status: 'completed'
      }
    } catch (err) {
      if (job.attempts < maxRetries) {
        jobs.push(job)
        return {
          error: err,
          job,
          status: 'retrying'
        }
      }

      return {
        error: err,
        job,
        status: 'failed'
      }
    }
  }

  function size() {
    return jobs.length
  }

  return {
    enqueue,
    processNext,
    size
  }
}

module.exports = {
  createJobQueue
}
