function setupGracefulShutdown({ db, io, server }) {
  let shutdownInProgress = false;

  function closeDatabaseAndExit(exitCode) {
    try {
      if (db.open) {
        db.close();
        console.log('[Shutdown] SQLite database closed.');
      }
    } catch (err) {
      console.error('[Shutdown] Failed to close SQLite database:', err);
      exitCode = 1;
    }

    process.exit(exitCode);
  }

  function gracefulShutdown(signal) {
    if (shutdownInProgress) {
      console.log(`[Shutdown] ${signal} received while shutdown is already in progress.`);
      return;
    }

    shutdownInProgress = true;
    console.log(`[Shutdown] Received ${signal}. Closing Terrible Butler.`);

    const forceExitTimer = setTimeout(() => {
      console.error('[Shutdown] Graceful shutdown exceeded 5 seconds. Forcing exit.');
      process.exit(1);
    }, 5000);

    forceExitTimer.unref();

    const finishShutdown = (exitCode = 0) => {
      clearTimeout(forceExitTimer);
      closeDatabaseAndExit(exitCode);
    };

    try {
      io.close(() => {
        console.log('[Shutdown] Socket.io closed.');

        server.close((err) => {
          if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
            console.error('[Shutdown] Failed to close HTTP server:', err);
            finishShutdown(1);
            return;
          }

          console.log('[Shutdown] HTTP server closed.');
          finishShutdown(0);
        });
      });
    } catch (err) {
      console.error('[Shutdown] Failed while closing Socket.io:', err);

      server.close((serverErr) => {
        if (serverErr && serverErr.code !== 'ERR_SERVER_NOT_RUNNING') {
          console.error('[Shutdown] Failed to close HTTP server:', serverErr);
        }

        finishShutdown(1);
      });
    }
  }

  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = { setupGracefulShutdown };
