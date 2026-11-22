import { maxWorkflowAttachmentBytes, maxWorkflowAttachments, maxWorkflowFilePaths, validateWorkflowFileAccess,
  validWorkflowFileName } from '../workflow-engine/state.mjs';

const attachmentLimit = `${maxWorkflowAttachmentBytes / 1024} KiB`;

async function verifiedTarget(readFileTarget, provider, signal) {
  try {
    const target = await readFileTarget(provider, signal);
    if (typeof target === 'string' && target.length) return target;
  } catch {
    // The route lookup can fail before a target is verified.
  }
  throw new Error('无法核验此执行工具的远端目标。请检查连接后重试。');
}

const mismatchMessage = '现有授权属于另一远端目标。请清除现有授权，核对目标后重新添加。';

export function createStageFileAccessEditor(React) {
  const h = React.createElement;

  return function StageFileAccessEditor({ stage, connected, open, catalogScope, readFileTarget, saveAttachments,
    busy, disabled, onChange, onRequest, localSdk }) {
    const helpId = React.useId();
    const [path, setPath] = React.useState('');
    const [error, setError] = React.useState('');
    const [verification, setVerification] = React.useState(null);
    const [retry, setRetry] = React.useState(0);
    const reader = React.useRef(readFileTarget);
    React.useLayoutEffect(() => { reader.current = readFileTarget; }, [readFileTarget]);

    const { provider, fileAccess } = stage;
    const targetId = fileAccess?.targetId;
    const paths = fileAccess?.paths ?? [];
    const attachments = fileAccess?.attachments ?? [];
    const canResolve = connected && typeof readFileTarget === 'function';
    const canCheck = open && canResolve && Boolean(targetId);
    const checkScope = React.useMemo(() => ({ provider, targetId }), [provider, targetId, catalogScope, canCheck, retry]);
    const targetResult = verification?.scope === checkScope ? verification.result : null;

    React.useEffect(() => {
      if (!canCheck) return undefined;
      const controller = new AbortController();
      const report = (result) => {
        if (!controller.signal.aborted) setVerification({ scope: checkScope, result });
      };
      verifiedTarget(reader.current, provider, controller.signal).then(
        (target) => report(target === targetId ? 'matched' : 'mismatch'),
        () => report('error'),
      );
      return () => controller.abort();
    }, [canCheck, checkScope, provider, targetId]);

    async function resolveGrantTarget(signal) {
      const currentTarget = await verifiedTarget(readFileTarget, provider, signal);
      if (targetId && currentTarget !== targetId) {
        if (!signal.aborted) setVerification({ scope: checkScope, result: 'mismatch' });
        throw new Error(mismatchMessage);
      }
      return currentTarget;
    }

    const addDisabled = disabled || busy || !canResolve || targetResult === 'mismatch';

    async function runEdit(operation) {
      setError('');
      try {
        return await onRequest(operation);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '无法更新阶段文件授权。');
        return false;
      }
    }

    async function addPath() {
      if (addDisabled || !path) return;
      const added = await runEdit(async (signal) => {
        const target = await resolveGrantTarget(signal);
        return validateWorkflowFileAccess({ targetId: target, paths: [...paths, path], attachments });
      });
      if (added) setPath('');
    }

    async function addAttachments(event) {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = '';
      if (addDisabled || !files.length || typeof saveAttachments !== 'function') return;
      const allFiles = [...attachments, ...files];
      if (allFiles.length > maxWorkflowAttachments || allFiles.some(({ size }) => size <= 0) ||
          allFiles.reduce((total, { size }) => total + size, 0) > maxWorkflowAttachmentBytes) {
        setError(`每阶段最多 ${maxWorkflowAttachments} 个非空附件，总大小不得超过 ${attachmentLimit}。`);
        return;
      }
      if (files.some(({ name }) => !validWorkflowFileName(name))) {
        setError('所选附件的文件名无效。');
        return;
      }
      if (new Set(allFiles.map(({ name }) => name)).size !== allFiles.length) {
        setError('同一阶段的附件文件名必须唯一。');
        return;
      }

      await runEdit(async (signal) => {
        const target = await resolveGrantTarget(signal);
        signal.throwIfAborted();
        let imported;
        try {
          imported = await saveAttachments(files);
        } catch {
          throw new Error('无法保存所选本地附件。请确认文件可读后重试。');
        }
        signal.throwIfAborted();
        if (!Array.isArray(imported) || imported.length !== files.length || imported.some((entry, index) =>
          entry?.name !== files[index].name || entry.size !== files[index].size)) throw new Error('未能保存全部所选附件。');
        if (await resolveGrantTarget(signal) !== target) throw new Error('导入期间远端目标已变化。请核对目标后重新选择附件。');
        return validateWorkflowFileAccess({ targetId: target, paths, attachments: [...attachments, ...imported] });
      });
    }

    function remove(remainingPaths, remainingAttachments) {
      setError('');
      onChange(remainingPaths.length || remainingAttachments.length
        ? { targetId, paths: remainingPaths, attachments: remainingAttachments } : undefined);
    }

    function list(label, entries, removeEntry) {
      if (!entries.length) return null;
      return h('ul', { className: 'vc-workflow-file-list', 'aria-label': label }, entries.map((name, index) =>
        h('li', { key: name }, h('code', null, name),
          h('button', { type: 'button', className: 'vc-button', 'aria-label': `移除${label} ${name}`,
            onClick: () => removeEntry(index) }, '移除'))));
    }

    const status = !canResolve ? '当前无法核验执行目标。启用并连接此执行工具后可添加授权。'
      : targetResult === 'matched' ? (localSdk ? '现有授权与当前本机配置匹配。' : '现有授权与当前远端目标匹配。')
      : targetResult === 'error' ? '无法核验现有授权的远端目标。请检查连接后重试。'
      : canCheck && !targetResult ? '正在核验现有授权的远端目标…' : '';

    return h('fieldset', { className: 'vc-workflow-files', disabled: disabled || busy, 'aria-describedby': helpId },
      h('legend', null, '阶段文件授权'),
      h('p', { id: helpId, className: 'vc-workflow-note' },
        !fileAccess && '此阶段默认无文件授权。',
        localSdk ? '路径相对于已登记的本机工作目录。授权文件和附件以只读资料提供。回复可在阶段产物中导出。' :
          h(React.Fragment, null, '远端路径相对于项目工作区根目录，仅支持单个常规文件。附件快照位于 ',
            h('code', null, '/attachments/<name>'), '，阶段产物写入 ', h('code', null, '/output'), '。上游文件需要单独授权。')),
      status && h('p', { className: 'vc-workflow-note', role: 'status' }, status),
      (targetResult === 'mismatch' || error) && h('p', { className: 'vc-workflow-error', role: 'alert' },
        targetResult === 'mismatch' ? mismatchMessage : error),
      (targetResult === 'error' || targetResult === 'mismatch') && h('button', { type: 'button', className: 'vc-button',
        onClick: () => { setError(''); setRetry((value) => value + 1); } }, '重新核验目标'),
      list(localSdk ? '本机路径' : '远端路径', paths, (index) => remove(paths.filter((_, position) => position !== index), attachments)),
      list('本地附件', attachments.map(({ name }) => name),
        (index) => remove(paths, attachments.filter((_, position) => position !== index))),
      h('div', { className: 'vc-workflow-file-path-row' },
        h('label', { className: 'vc-workflow-field' }, h('span', null, localSdk ? '本机相对路径' : '远端相对路径'),
          h('input', { value: path, placeholder: 'docs/brief.md', disabled: addDisabled, spellCheck: false,
            onChange: (event) => { setPath(event.target.value); setError(''); },
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void addPath();
              }
            } })),
        h('button', { type: 'button', className: 'vc-button', disabled: addDisabled || !path, onClick: addPath },
          localSdk ? '添加本机路径' : '添加远端路径')),
      h('label', { className: 'vc-workflow-field' }, h('span', null, '选择本地附件'),
        h('input', { type: 'file', multiple: true, disabled: addDisabled || typeof saveAttachments !== 'function',
          onChange: addAttachments })),
      h('p', { className: 'vc-workflow-note' },
        `每阶段最多 ${maxWorkflowFilePaths} 个路径与 ${maxWorkflowAttachments} 个附件，附件合计最多 ${attachmentLimit}。`),
      fileAccess && h('button', { type: 'button', className: 'vc-button', onClick: () => remove([], []) }, '清除此阶段文件授权'));
  };
}
