import { useCallback, useEffect, useRef, useState } from "react";

export interface GitStatus {
  currentMainSha: string;
  latestCommitMsg: string;
  builtFromSha: string | null;
  newOnMainCount: number;   // commits on main since last build; -1 = unknown; 0 = up to date
  upToDate: boolean;
  buildInProgress: boolean;
  lastBuiltAt: string | null;
}

export interface BuildStatus {
  inProgress: boolean;
  lastLines?: string;
  error?: string;
}

const POLL_INTERVAL_MS = 5 * 60_000; // refresh git status every 5 minutes
const BUILD_POLL_MS = 3_000;         // poll build progress every 3s

export function useGitStatus() {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [buildStatus, setBuildStatus] = useState<BuildStatus>({ inProgress: false });
  const buildPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchGitStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/git/status");
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
        setGitError(err.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as GitStatus;
      setGitStatus(data);
      setGitError(null);
    } catch (err) {
      setGitError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const stopBuildPoll = useCallback(() => {
    if (buildPollRef.current) {
      clearInterval(buildPollRef.current);
      buildPollRef.current = null;
    }
  }, []);

  const pollBuildStatus = useCallback(() => {
    stopBuildPoll();
    buildPollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/build/status");
        const data = (await res.json()) as { inProgress: boolean; lastLines?: string };
        setBuildStatus({ inProgress: data.inProgress, lastLines: data.lastLines });
        if (!data.inProgress) {
          stopBuildPoll();
          void fetchGitStatus();
        }
      } catch {
        stopBuildPoll();
      }
    }, BUILD_POLL_MS);
  }, [fetchGitStatus, stopBuildPoll]);

  const triggerBuild = useCallback(async (force = false) => {
    setBuildStatus({ inProgress: true });
    try {
      const res = await fetch("/api/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
        setBuildStatus({ inProgress: false, error: err.error ?? `HTTP ${res.status}` });
        return;
      }
      pollBuildStatus();
    } catch (err) {
      setBuildStatus({
        inProgress: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [pollBuildStatus]);

  useEffect(() => {
    void fetchGitStatus();
    const timer = setInterval(() => void fetchGitStatus(), POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      stopBuildPoll();
    };
  }, [fetchGitStatus, stopBuildPoll]);

  return { gitStatus, gitError, buildStatus, triggerBuild, refreshGitStatus: fetchGitStatus };
}
