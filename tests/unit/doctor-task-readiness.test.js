const {
  isTaskNotReadyError,
  waitForDoctorTask,
} = require('../../src/services/integrations/doctor-task-readiness');

describe('Doctor task readiness', () => {
  test('waits through the outbox propagation window', async () => {
    let attempts = 0;
    const result = await waitForDoctorTask(async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('The patient task was not found.');
        error.statusCode = 404;
        error.code = 'PATIENT_TASK_NOT_FOUND';
        throw error;
      }
      return { status: 'queued' };
    }, [0, 0]);

    expect(result).toEqual({ status: 'queued' });
    expect(attempts).toBe(3);
  });

  test('returns a retryable conflict instead of an internal error when the task is still unavailable', async () => {
    await expect(
      waitForDoctorTask(async () => {
        const error = new Error('The patient task was not found.');
        error.statusCode = 404;
        error.code = 'PATIENT_TASK_NOT_FOUND';
        throw error;
      }, [0])
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOCTOR_TASK_NOT_READY',
      retryable: true,
    });
  });

  test('does not retry unrelated errors', async () => {
    const error = new Error('Doctor integration unavailable.');
    error.statusCode = 502;
    error.code = 'DOCTOR_INTEGRATION_FAILED';

    await expect(waitForDoctorTask(async () => Promise.reject(error), [0])).rejects.toBe(error);
    expect(isTaskNotReadyError(error)).toBe(false);
  });
});
