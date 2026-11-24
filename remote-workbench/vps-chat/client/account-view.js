import { t } from './interface-language.js';
import { afterPopupMotion } from './menu-motion.js';
import { accountStartupMessage, getAccountAction } from './account-routes.js';

const accountSocketPath = '/dsh-vps-chat/api/account-screen';
const clipboardActions = new Set(['codex-login', 'claude-login', 'antigravity-login']);
const clipboardLimit = 8192;
const utf8 = new TextEncoder();
const allowedClipboardText = (text) => typeof text === 'string' && text.length > 0 &&
  text.length <= clipboardLimit && !text.includes('\0') && utf8.encode(text).length <= clipboardLimit;
const accountPlayerPath = '/dsh-vps-chat/api/account-player.mjs';
const bindingFields = ['host', 'port', 'user', 'identityPath', 'knownHostsPath', 'expectedIpv4', 'expectedIpv6'];

function sameVps(settings, preset) {
  return settings?.hostKeyConfirmed === true && preset?.hostKeyConfirmed === true &&
    bindingFields.every(key => settings[key] === preset[key]);
}

export function createAccountDialog(React, writeClipboard) {
  const h = React.createElement;
  return function AccountDialog({ rpc, settings, actionId, close }) {
    const dialog = React.useRef(null);
    const screen = React.useRef(null);
    const stop = React.useRef(null);
    const connection = React.useRef(null);
    const copiedFromVps = React.useRef('');
    const [connected, setConnected] = React.useState(false);
    const [canCopy, setCanCopy] = React.useState(false);
    const [clipboardStatus, setClipboardStatus] = React.useState('');
    const cancelExit = React.useRef(null);
    const closing = React.useRef(false);
    const action = getAccountAction(actionId);
    const clipboardEnabled = clipboardActions.has(actionId);
    const [status, setStatus] = React.useState(t('正在核对 VPS 连接与出口…'));
    const [attempt, setAttempt] = React.useState(0);
    const [retryable, setRetryable] = React.useState(false);

    React.useLayoutEffect(() => {
      const element = dialog.current;
      element.showModal();
      return () => {
        cancelExit.current?.();
        if (element.open) element.close();
      };
    }, []);

    function resetClipboard() {
      connection.current = null;
      copiedFromVps.current = '';
      setConnected(false);
      setCanCopy(false);
      setClipboardStatus('');
    }

    function pasteIntoVps(event) {
      event.preventDefault();
      const viewer = connection.current;
      if (!event.nativeEvent.isTrusted || !viewer) return;
      const value = event.clipboardData.getData('text/plain');
      if (!allowedClipboardText(value) || /[\r\n]/.test(value)) {
        setClipboardStatus('请粘贴一行文本，最多 8 KiB。');
        return;
      }
      viewer.clipboardPasteFrom(value);
      setClipboardStatus('已送到 VPS 剪贴板。请在远端浏览器粘贴，或在终端按 Shift+Insert。');
    }

    async function copyToComputer() {
      const viewer = connection.current;
      const value = copiedFromVps.current;
      if (!viewer || !allowedClipboardText(value)) return;
      try {
        const copied = await writeClipboard(value);
        if (connection.current === viewer) setClipboardStatus(copied ? '已复制到本机剪贴板。' : '无法写入本机剪贴板。');
      } catch {
        if (connection.current === viewer) setClipboardStatus('无法写入本机剪贴板。');
      }
    }

    React.useEffect(() => {
      const controller = new AbortController();
      let viewer;
      let socket;
      let startupMessage;
      const disconnect = () => {
        controller.abort();
        resetClipboard();
        const connection = viewer;
        viewer = undefined;
        connection?.disconnect();
        if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
      };
      stop.current = disconnect;
      void (async () => {
        try {
          const { preset } = await rpc('preset', {}, controller.signal);
          if (controller.signal.aborted) return;
          if (!sameVps(settings, preset?.settings) || typeof preset.targetId !== 'string' || !/^[a-f0-9]{64}$/.test(preset.targetId)) {
            setStatus(t('请切回已核对指纹的默认 VPS，再打开账号窗口。'));
            return;
          }
          const { protocol, port } = await rpc('account-view', { targetId: preset.targetId, action: actionId }, controller.signal);
          if (controller.signal.aborted) return;
          if (typeof protocol !== 'string' || !/^dsh-account\.[\w-]{43}$/.test(protocol) ||
              !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t('远程画面凭证无效。'));
          const { default: RFB } = await import(new URL(accountPlayerPath, window.location.href).href);
          if (controller.signal.aborted) return;
          const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
          const host = window.location.hostname === 'localhost' ? 'localhost' : '127.0.0.1';
          socket = new WebSocket(`${scheme}://${host}:${port}${accountSocketPath}`, [protocol]);
          socket.addEventListener('close', (event) => {
            if (controller.signal.aborted || event.code !== 1011) return;
            startupMessage = t(accountStartupMessage(event.reason));
            if (startupMessage) {
              setStatus(startupMessage);
              setRetryable(true);
            }
          });
          viewer = new RFB(screen.current, socket, { shared: false });
          viewer.scaleViewport = true;
          viewer.showDotCursor = true;
          if (clipboardEnabled) viewer.addEventListener('clipboard', ({ detail }) => {
            if (controller.signal.aborted || connection.current !== viewer) return;
            copiedFromVps.current = allowedClipboardText(detail?.text) ? detail.text : '';
            setCanCopy(Boolean(copiedFromVps.current));
          });
          viewer.addEventListener('connect', () => {
            if (controller.signal.aborted) return;
            connection.current = viewer;
            setConnected(true);
            setStatus(action.terminal ? t('已连接 VPS 账号操作窗口') : t('已连接 VPS 浏览器'));
          });
          viewer.addEventListener('disconnect', () => {
            if (!controller.signal.aborted) {
              resetClipboard();
              setStatus(startupMessage ?? (action.terminal
                ? t('VPS 操作窗口已断开或未启动。请核对远端浏览器、xterm 和对应 CLI。')
                : t('VPS 浏览器已断开或未启动。请核对远端浏览器和出口配置。')));
              setRetryable(true);
            }
          });
        } catch (error) {
          if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
          if (!controller.signal.aborted) {
            setStatus(error.code ? error.message : t('无法打开 VPS 账号窗口。'));
            setRetryable(true);
          }
        }
      })();
      return disconnect;
    }, [rpc, settings, actionId, action, attempt, clipboardEnabled]);

    function dismiss() {
      if (closing.current) return;
      closing.current = true;
      stop.current?.();
      dialog.current.close();
      cancelExit.current = afterPopupMotion(dialog.current, close);
    }

    function retry() {
      setRetryable(false);
      setStatus(t('正在核对 VPS 连接与出口…'));
      setAttempt(previous => previous + 1);
    }

    return h('dialog', {
      ref: dialog, className: 'vc-account-dialog vc-popup-motion', 'aria-label': t(action.title),
      onCancel: (event) => { event.preventDefault(); dismiss(); },
    },
    h('header', { className: 'vc-account-header' },
      h('div', null, h('strong', null, t(action.title)), h('div', { role: 'status' }, status)),
      h('div', { className: 'vc-account-header-actions' },
        retryable ? h('button', { type: 'button', className: 'vc-button vc-settings-outline', onClick: retry }, t('重新打开')) : null,
        h('button', { type: 'button', className: 'vc-button', onClick: dismiss }, t('关闭账号窗口')))),
    h('p', { className: 'vc-account-tip' }, clipboardEnabled
      ? t('授权链接会在当前 VPS 浏览器打开。若只显示链接，请复制后在远端浏览器粘贴。返回终端时可按 Shift+Insert。')
      : action.terminal
      ? t('在下面的 VPS 画面完成操作。登录地址和验证码只在这个窗口内使用。')
      : t('网页登录仅用于本次窗口。关闭后，下次打开需要重新登录。')),
    clipboardEnabled ? h('div', { className: 'vc-account-clipboard', role: 'group', 'aria-label': t('VPS 剪贴板') },
      h('label', null, t('从本机粘贴'),
        h('input', { type: 'text', value: '', onChange: () => {}, onPaste: pasteIntoVps, disabled: !connected,
          placeholder: t('在此按 Ctrl+V'), autoComplete: 'off', spellCheck: false })),
      typeof writeClipboard === 'function' ? h('button', { type: 'button', className: 'vc-button',
        disabled: !connected || !canCopy, onClick: () => void copyToComputer() }, t('复制到本机')) : null,
      clipboardStatus ? h('small', { role: 'status' }, t(clipboardStatus)) : null) : null,
    h('div', { ref: screen, className: 'vc-account-screen', 'aria-label': t('VPS 浏览器画面') }));
  };
}

export const accountDialogCss = `
  [data-vps-chat] .vc-account-entry {text-align:left; background:transparent; border-color:transparent; flex:none}
  [data-vps-chat] .vc-account-dialog {
    width:min(1120px,calc(100% - 24px)); height:min(840px,calc(100% - 24px)); max-width:none; max-height:none;
    background:var(--vc-surface); color:var(--vc-ink); border:1px solid var(--vc-line);
    border-radius:14px; padding:12px; box-shadow:var(--vc-shadow); overflow:hidden;
  }
  [data-vps-chat] .vc-account-dialog[open] {display:flex; flex-direction:column; gap:10px}
  [data-vps-chat] .vc-account-dialog::backdrop {background:var(--vc-overlay)}
  [data-vps-chat] .vc-account-header {display:flex; align-items:center; justify-content:space-between; gap:8px; padding:2px 4px}
  [data-vps-chat] .vc-account-header [role=status] {color:var(--vc-muted); font-size:12px}
  [data-vps-chat] .vc-account-header-actions {display:flex; flex-wrap:wrap; justify-content:flex-end; gap:5px}
  [data-vps-chat] .vc-account-tip {color:var(--vc-muted); font-size:12px; margin:0 4px}
  [data-vps-chat] .vc-account-clipboard {display:flex; gap:6px 10px; flex-wrap:wrap; align-items:center; padding:0 4px}
  [data-vps-chat] .vc-account-clipboard label {display:flex; align-items:center; gap:6px; min-width:0}
  [data-vps-chat] .vc-account-clipboard input {min-width:0; width:140px; max-width:100%; padding:4px 6px;
    background:var(--vc-stage); color:var(--vc-ink); border:1px solid var(--vc-line); border-radius:5px}
  [data-vps-chat] .vc-account-clipboard small {color:var(--vc-muted)}
  [data-vps-chat] .vc-account-screen {min-height:0; flex:1; overflow:hidden; background:var(--vc-stage); border-radius:8px}
  /* Keep the local pointer visible even when the remote session replaces its cursor with a blank image. */
  [data-vps-chat] .vc-account-screen canvas {cursor:default !important}
`;
