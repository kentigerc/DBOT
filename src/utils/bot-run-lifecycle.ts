// A stopped UI does not mean asynchronous interpreter/socket cleanup has finished.
export class BotRunLifecycle {
    stopping = false;
    private task?: Promise<void>;
    stop(operation: () => Promise<void>) {
        if (this.stopping) return this.task || Promise.resolve();
        this.stopping = true;
        const task = (async () => {
            await operation();
        })();
        this.task = task.finally(() => {
            this.stopping = false;
            this.task = undefined;
        });
        return this.task;
    }
    async waitUntilStopped(timeoutMs = 15000) {
        if (!this.task) return;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.task,
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    'The previous XML run is still stopping. Wait for its open trade and cleanup to finish.'
                                )
                            ),
                        timeoutMs
                    );
                }),
            ]);
        } finally {
            clearTimeout(timeout);
        }
    }
}
