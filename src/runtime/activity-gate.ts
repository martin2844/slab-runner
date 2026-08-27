import { RunnerError } from "./errors.js";

export interface ActivityLease {
  release(): void;
}

export class RuntimeActivityGate {
  #activeRuns = 0;
  #authMutation = false;

  beginRun(): ActivityLease {
    if (this.#authMutation) {
      throw new RunnerError(
        "RUNTIME_UNAVAILABLE",
        "Runtime authentication is changing",
        409,
      );
    }
    this.#activeRuns += 1;
    return this.lease(() => {
      this.#activeRuns -= 1;
    });
  }

  beginAuthMutation(): ActivityLease {
    if (this.#authMutation || this.#activeRuns > 0) {
      throw new RunnerError(
        "INVALID_REQUEST",
        "Runtime authentication cannot change while the runtime is active",
        409,
      );
    }
    this.#authMutation = true;
    return this.lease(() => {
      this.#authMutation = false;
    });
  }

  private lease(onRelease: () => void): ActivityLease {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        onRelease();
      },
    };
  }
}
