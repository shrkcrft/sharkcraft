import type { AppError } from '@shrkcrft/core';

export function printError(error: AppError | Error): void {
  if ('code' in error) {
    const ae = error as AppError;
    process.stderr.write(`Error [${ae.code}]: ${ae.message}\n`);
    if (ae.suggestion) process.stderr.write(`  hint: ${ae.suggestion}\n`);
    if (ae.details && Object.keys(ae.details).length) {
      process.stderr.write(`  details: ${JSON.stringify(ae.details)}\n`);
    }
  } else {
    process.stderr.write(`Error: ${error.message}\n`);
  }
}
