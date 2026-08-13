// Shell page logic: renders Choose / Loading / Error from main-process state.
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
      $('error-workspace').textContent = state.workspace ?? '(none)';
      $('error-reason').textContent = state.error ?? 'unknown error';
      $('error-logs').textContent = state.logTail || '(no output captured)';
      show('error');
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

  $('btn-choose-another').addEventListener('click', () => {
    void api.chooseAnother();
  });

  $('btn-toggle-logs').addEventListener('click', () => {
    const logs = $('error-logs');
    logs.classList.toggle('hidden');
    if (!logs.classList.contains('hidden')) {
      void api.getState().then((state) => {
        logs.textContent = state.logTail || '(no output captured)';
      });
    }
  });

  api.onState(apply);
  void api.getState().then(apply);
})();
