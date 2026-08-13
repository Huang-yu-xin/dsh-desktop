// Shell page logic: renders Choose / Loading / Error / Connection Lost from
// main-process state, plus the minimal logs panel (stdout/stderr, copy, close).
(() => {
  const api = window.dshDesktop;

  const $ = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (el === null) throw new Error(`missing element #${id}`);
    return el;
  };

  const views = {
    choose: $('view-choose'),
    starting: $('view-starting'),
    error: $('view-error'),
    lost: $('view-lost'),
  };

  function show(view: keyof typeof views): void {
    for (const [name, el] of Object.entries(views)) {
      el.classList.toggle('hidden', name !== view);
    }
  }

  const phaseHints: Record<string, string> = {
    starting: 'Launching DeepSeek Harness (the first run may download the pinned release)…',
    'awaiting-url': 'Waiting for the harness readiness signal…',
    'awaiting-http': 'Harness is up — confirming HTTP…',
    stopping: 'Stopping harness…',
  };

  const reasonLabels: Record<string, string> = {
    'startup-failed': 'Startup failed',
    'process-exited': 'Process exited',
    'process-error': 'Process error',
    'unexpected-exit-code': 'Unexpected exit code',
    'health-check-failed': 'Health check failed',
    unknown: 'Unknown',
  };

  // Kinds that mean "the runtime was lost after it had been running" — these
  // get the connection-lost page; startup kinds get the failed-to-start page.
  const runtimeLossKinds = new Set(['process-exited', 'process-error', 'health-check-failed']);

  function reasonText(reason: DesktopReason | null): string {
    if (reason === null) return 'unknown error';
    const label = reasonLabels[reason.kind] ?? reason.kind;
    return `${label}: ${reason.message}`;
  }

  function showLost(state: DesktopState): void {
    $('lost-workspace').textContent = state.workspace ?? '(none)';
    $('lost-reason').textContent = reasonText(state.reason);
    show('lost');
  }

  function renderRecents(recents: RecentItem[]): void {
    const wrap = $('recents');
    const list = $('recents-list');
    list.replaceChildren();
    if (recents.length === 0) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    for (const r of recents) {
      const li = document.createElement('li');
      const open = document.createElement('button');
      open.className = 'recent-path';
      open.title = r.path;
      open.textContent = r.path;
      if (!r.exists) {
        const badge = document.createElement('span');
        badge.className = 'recent-missing';
        badge.textContent = '(missing)';
        open.appendChild(badge);
      }
      open.addEventListener('click', () => {
        void (async () => {
          const result = await api.start(r.path);
          if (!result.accepted) showChooseError(result.error ?? 'start rejected');
        })();
      });
      const time = document.createElement('span');
      time.className = 'recent-time';
      time.textContent = new Date(r.lastOpenedAt).toLocaleString();
      const remove = document.createElement('button');
      remove.className = 'recent-remove';
      remove.title = 'Remove from list';
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        void api.removeRecent(r.path);
      });
      li.append(open, time, remove);
      list.appendChild(li);
    }
  }

  function apply(state: DesktopState): void {
    if (state.phase === 'failed') {
      if (state.reason !== null && runtimeLossKinds.has(state.reason.kind)) {
        showLost(state);
      } else {
        $('error-workspace').textContent = state.workspace ?? '(none)';
        $('error-reason').textContent = reasonText(state.reason);
        show('error');
      }
    } else if (state.phase === 'disconnected') {
      showLost(state);
    } else if (state.phase === 'idle') {
      renderRecents(state.recents);
      show('choose');
    } else {
      $('starting-workspace').textContent = state.workspace ?? '(none)';
      $('starting-phase').textContent = phaseHints[state.phase] ?? state.phase;
      show('starting');
    }
  }

  function showChooseError(message: string): void {
    $('choose-error').textContent = message;
    $('choose-error').classList.remove('hidden');
  }

  async function openLogsPanel(): Promise<void> {
    const logs = await api.getLogs();
    $('logs-stdout').textContent = logs.stdout || '(no stdout captured)';
    $('logs-stderr').textContent = logs.stderr || '(no stderr captured)';
    $('logs-panel').classList.remove('hidden');
  }

  $('btn-open').addEventListener('click', () => {
    void (async () => {
      const picked = await api.pickWorkspace();
      if (picked === null) return;
      if (typeof picked === 'object') {
        showChooseError(picked.error);
        return;
      }
      const result = await api.start(picked);
      if (!result.accepted) showChooseError(result.error ?? 'start rejected');
    })();
  });

  $('btn-retry').addEventListener('click', () => {
    void api.retry();
  });

  $('btn-restart').addEventListener('click', () => {
    void api.restart();
  });

  $('btn-back').addEventListener('click', () => {
    void api.backToWorkspaces();
  });

  $('btn-choose-another').addEventListener('click', () => {
    void api.chooseAnother();
  });

  $('btn-show-logs').addEventListener('click', () => {
    void openLogsPanel();
  });

  $('btn-show-logs-lost').addEventListener('click', () => {
    void openLogsPanel();
  });

  $('btn-close-logs').addEventListener('click', () => {
    $('logs-panel').classList.add('hidden');
  });

  $('btn-copy-logs').addEventListener('click', () => {
    void api.copyLogs();
  });

  api.onState(apply);
  void api.getState().then(apply);
})();
