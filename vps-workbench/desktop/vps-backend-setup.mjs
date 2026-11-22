import React from 'react';

const h = React.createElement;
const providers = [
  ['codex', 'Codex'],
  ['claude', 'Claude CLI'],
  ['claude-sdk', 'Claude Agent SDK'],
  ['antigravity', 'Antigravity ACP'],
];
const distroNames = {
  ubuntu: 'Ubuntu', debian: 'Debian', fedora: 'Fedora', rhel: 'RHEL', rocky: 'Rocky Linux', almalinux: 'AlmaLinux',
};
const blockers = {
  linux_required: '此后端需要 Linux。请连接 Linux VPS 或 Linux 虚拟机。',
  unsupported_cpu: '当前 CPU 架构缺少配套运行时。',
  glibc_2_28_required: '此后端需要 glibc 2.28 以上。',
  non_root_user_required: '请使用运行模型的普通 VPS 用户重新连接。',
  invalid_home: '当前 VPS 用户的家目录不可用，请核对目录归属和权限。',
  dependency_missing: '请在 VPS 补齐所缺依赖后重新检查。',
  sandbox_unavailable: 'VPS 未能启动 Linux 沙箱。请核对内核和发行版的隔离策略。',
  sandbox_isolation_failed: 'VPS 未通过文件或网络隔离检查。',
  sandbox_ca_missing: 'VPS 缺少沙箱内可用的系统 CA 证书。',
  workspace_unavailable: '请先在 VPS 准备当前用户拥有的工作目录，或编辑连接选择已有目录。',
};
const installErrors = {
  artifact_download_failed: '下载失败，请检查 VPS 网络后重试。',
  artifact_digest_mismatch: '运行时完整性校验失败。',
  incompatible_runtime_on_ssh_path: 'SSH 路径中有不兼容的同名程序。',
  existing_sdk_requires_review: '已有 SDK 需要核对，原文件已保留。',
  unsafe_directory: '请核对 VPS 家目录下安装目录的归属和权限。',
  backend_storage_unavailable: '请核对 VPS 安装目录的权限和剩余磁盘空间。',
  unsafe_ssh_path: '请核对 VPS 非交互 PATH 中的目录和权限。',
  worker_start_failed: 'VPS 未能启动安装进程。',
  install_busy: 'VPS 正在处理另一项安装。',
};
const readyStates = new Set(['passed', 'will_create']);
const activeInstall = (job) => job?.state === 'running' || job?.state === 'unknown';
const installable = (platform) => platform?.system === 'Linux' && ['x64', 'arm64'].includes(platform.architecture) &&
  !platform.blocker && platform.sandbox === 'passed' && readyStates.has(platform.workspace);

function installOutcome(initial, result) {
  if (result?.targetId !== initial.targetId || result.install?.id !== initial.job.id)
    throw new Error('安装回执与本次 VPS 配置不匹配。');
  return result.install;
}

function recordInstall(current, job) {
  const platform = current.platform;
  if (!platform || activeInstall(job)) return { ...current, job };
  const providers = { ...platform.providers };
  for (const [id, detail] of Object.entries(job.results)) {
    if (detail.runtime === 'installed' || detail.runtime === 'existing')
      providers[id] = { runtime: 'found', onSshPath: detail.onSshPath };
  }
  return { ...current, platform: { ...platform, providers }, job };
}

export function useVpsBackendSetup({ rpc, remoteEnabled }) {
  const [data, setData] = React.useState(null);
  const [selected, setSelected] = React.useState([]);
  const [working, setWorking] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const pending = React.useRef(null);
  const reset = () => {
    pending.current?.abort();
    pending.current = null;
    setData(null);
    setSelected([]);
    setWorking(false);
    setNotice('');
  };
  React.useEffect(() => () => pending.current?.abort(), []);

  async function request(run, onError) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setWorking(true);
    setNotice('');
    try { await run(controller.signal); }
    catch (error) { if (!controller.signal.aborted) onError(error); }
    finally {
      if (pending.current === controller) {
        pending.current = null;
        setWorking(false);
      }
    }
  }

  async function detect(settings, targetId) {
    if (pending.current || typeof targetId !== 'string' || !/^[a-f0-9]{64}$/.test(targetId)) return;
    const target = { settings: { ...settings, provider: 'codex' }, targetId };
    setData((previous) => previous?.targetId === targetId ? previous : null);
    await request(async (signal) => {
      const reply = await rpc('setup-backend', { ...target, kind: 'probe' }, signal);
      signal.throwIfAborted();
      if (reply?.targetId !== targetId || (!reply.platform && !(reply.probeError && activeInstall(reply.install))))
        throw new Error('VPS 系统检查结果不可用。');
      setData({ ...target, platform: reply.platform, probeError: reply.probeError, job: reply.install });
      setSelected([]);
    }, (error) => {
      setData((previous) => previous?.targetId === targetId ? { ...previous, platform: null } : null);
      setNotice(error?.message || '无法检查 VPS 后端。请重试。');
    });
  }

  async function start() {
    if (pending.current || !remoteEnabled || !installable(data?.platform) || activeInstall(data.job) || !selected.length) return;
    const job = { id: globalThis.crypto.randomUUID(), providers: providers.map(([id]) => id).filter((id) => selected.includes(id)),
      state: 'unknown', results: {} };
    const initial = { ...data, job };
    setData(initial);
    await request(async (signal) => {
      const reply = await rpc('setup-backend', { settings: data.settings, targetId: data.targetId, kind: 'start',
        installId: job.id, providers: job.providers }, signal);
      signal.throwIfAborted();
      setData(recordInstall(data, installOutcome(initial, reply)));
      setSelected([]);
    }, (error) => {
      if (error?.code === 'backend_pending') {
        setData({ ...data, platform: null });
        setNotice('此 VPS 有待确认的安装。请重新检查并查询原安装。');
      } else if (['backend_package_unavailable', 'workbench_browse_only'].includes(error?.code)) {
        setData(data);
        setNotice(error.message);
      } else setNotice('尚未确认安装请求。请查询原安装。');
    });
  }

  async function inspect(current) {
    if (pending.current || !current?.job || !remoteEnabled) return;
    await request(async (signal) => {
      const reply = await rpc('setup-backend', { settings: current.settings, targetId: current.targetId,
        kind: 'status', installId: current.job.id }, signal);
      signal.throwIfAborted();
      setData(recordInstall(current, installOutcome(current, reply)));
    }, (error) => {
      setNotice(error?.message || '暂时无法查询安装回执。');
      setData({ ...current, job: error?.code === 'backend_receipt_missing' ? null : { ...current.job, state: 'unknown' } });
    });
  }

  React.useEffect(() => {
    if (!remoteEnabled || working || data?.job?.state !== 'running') return;
    const timer = setTimeout(() => void inspect(data), 2000);
    return () => clearTimeout(timer);
  }, [data, working, remoteEnabled]);

  return { data, selected, working, notice, detect, start, inspect, reset, toggle(id) {
    setSelected((list) => list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  } };
}

const statusText = {
  running: '正在 VPS 上安装',
  succeeded: '安装完成',
  failed: '安装未全部完成',
  unknown: '等待确认原安装结果',
};
const runtimeText = {
  found: '已检测到运行时',
  existing: '保留已有运行时',
  installed: '已安装',
  missing: '待安装',
  sdk_missing: '待安装 SDK',
  profile_not_configured: '运行时可用，待配置账号',
  failed: '安装失败',
};

export function VpsBackendSetup({ installer, disabled }) {
  const { data, selected, working, notice, start, inspect, toggle } = installer;
  const { platform, job, probeError } = data ?? {};
  const canInstall = installable(platform);
  const blocked = disabled || working || activeInstall(job);
  const lastResults = canInstall ? [] : providers.filter(([id]) => job?.results?.[id]);
  const architecture = { x64: 'x86‑64', arm64: 'ARM64' }[platform?.architecture] ?? '架构待确认';
  const status = platform && [distroNames[platform.distribution] ?? platform.distribution ?? platform.system ?? '系统待确认',
    platform.distributionVersion, architecture].filter(Boolean).join(' · ');
  const dependencies = platform?.blocker === 'dependency_missing' && {
    apt: 'sudo apt-get install python3 bubblewrap iproute2 curl ca-certificates',
    dnf: 'sudo dnf install python3 bubblewrap iproute curl ca-certificates',
  }[platform?.packageManager];
  const button = (label, action, props) => h('button', { type: 'button', className: 'vc-button vc-settings-outline',
    onClick: action, ...props }, label);
  return h('li', { className: 'vc-setup-step vc-setup-backend', 'aria-label': 'VPS 后端安装' },
    h('div', { className: 'vc-setup-overview' }, h('h4', null, 'VPS 后端安装'),
      h('small', { className: 'vc-settings-current' }, '可选')),
    h('p', { role: 'status' }, status || (probeError ? '等待重新检查 VPS 系统。' : working
      ? '正在识别 VPS 系统和架构…' : '连接 VPS 后会自动识别系统和架构。')),
    probeError ? h('p', { role: 'alert' }, probeError) : null,
    platform?.blocker ? h('p', { role: 'alert' }, blockers[platform.blocker] || 'VPS 未通过后端预检，请重新检查。') : null,
    platform?.missing?.length ? h('p', null, '缺少 ' + platform.missing.join('、')) : null,
    dependencies ? h('code', { className: 'vc-setup-backend-dependencies' }, dependencies) : null,
    platform?.workspace === 'will_create' ? h('p', null, '安装将创建默认工作目录。') : null,
    canInstall ? h('fieldset', { className: 'vc-setup-providers', disabled: blocked },
      h('legend', null, '要安装的执行端'),
      h('div', { className: 'vc-setup-backend-options' }, providers.map(([id, label]) => {
        const result = job?.results?.[id];
        const current = platform.providers?.[id];
        return h('label', { key: id, className: 'vc-setup-provider', 'data-picked': selected.includes(id) },
          h('input', { type: 'checkbox', 'aria-label': label, checked: selected.includes(id), onChange: () => toggle(id) }),
          h('span', null, h('strong', null, label), h('small', null, runtimeText[current?.runtime ?? 'missing'],
            current?.onSshPath === false && current.runtime !== 'missing' ? ' · 请核对 SSH PATH' : ''),
          result ? h('small', null, '上次安装 · ', h('span', null, installErrors[result.code] ?? runtimeText[result.runtime])) : null));
      }))) : null,
    lastResults.length ? h('ul', null, lastResults.map(([id, label]) => {
      const result = job.results[id];
      return h('li', { key: id }, label, ' · ', h('span', null, installErrors[result.code] ?? runtimeText[result.runtime]));
    })) : null,
    job ? h('p', { role: 'status' }, statusText[job.state],
      job.state === 'failed' && job.code ? '。' + (installErrors[job.code] || blockers[job.code] || '请重新检查 VPS 状态。') : '',
      job.state === 'succeeded' ? '。可以继续检查账号和模型目录。' : '') : null,
    notice ? h('p', { role: 'alert' }, notice) : null,
    (canInstall || activeInstall(job)) && h('div', { className: 'vc-setup-actions' },
      activeInstall(job) ? button('查询原安装', () => void inspect(data), { disabled: disabled || working })
        : button('安装所选执行端', () => void start(), { className: 'vc-button vc-primary', disabled: blocked || !selected.length })),
    canInstall && !job ? h('p', null, '使用当前 SSH 用户安装并校验运行时。保留已有账号、配置和会话。') : null);
}
