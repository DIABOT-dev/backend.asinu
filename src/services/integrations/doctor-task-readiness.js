const TASK_NOT_READY_CODES = new Set([
  'PATIENT_TASK_NOT_FOUND',
  'DOCTOR_TASK_NOT_FOUND',
  'TASK_NOT_FOUND',
]);

// The task request is delivered through an outbox. A patient can therefore
// upload an attachment or send a first message before Doctor has committed the
// task projection. Keep that short propagation window invisible to the user.
const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1000, 1500, 2000];

const sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const isTaskNotReadyError = (error) =>
  Boolean(error && error.statusCode === 404 && TASK_NOT_READY_CODES.has(error.code));

const createTaskNotReadyError = () => {
  const error = new Error(
    'The consultation is still being prepared. Please try again in a moment.'
  );
  error.statusCode = 409;
  error.code = 'DOCTOR_TASK_NOT_READY';
  error.retryable = true;
  return error;
};

const waitForDoctorTask = async (loadStatus, delays = DEFAULT_RETRY_DELAYS_MS) => {
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await loadStatus();
    } catch (error) {
      if (!isTaskNotReadyError(error)) throw error;
      const delay = delays[attempt];
      if (delay === undefined) throw createTaskNotReadyError();
      await sleep(delay);
    }
  }

  throw createTaskNotReadyError();
};

module.exports = {
  DEFAULT_RETRY_DELAYS_MS,
  createTaskNotReadyError,
  isTaskNotReadyError,
  waitForDoctorTask,
};
