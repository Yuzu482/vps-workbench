import { afterPopupMotion } from './menu-motion.js';
import { accountStartupMessage, getAccountAction } from './account-routes.js';

const accountSocketPath = '/dsh-vps-chat/api/account-screen';
const accountPlayerPath = '/dsh-vps-chat/api/account-player.mjs';
const bindingFields = ['host', 'port', 'user', 'identityPath', 'knownHostsPath', 'expectedIpv4', 'expectedIpv6'];

function sameVps(settings, preset) {
  return settings?.hostKeyConfirmed === true && preset?.hostKeyConfirmed === true &&
    bindingFields.every(key => settings[key] === preset[key]);
}

export function createAccountDialog(React) {
  const h = React.createElement;
  return function AccountDialog({ rpc, settings, actionId, close }) {
    const dialog = React.useRef(null);
    const screen = React.useRef(null);
    const stop = React.useRef(null);
    const cancelExit = React.useRef(null);
    const closing = React.useRef(false);
    const action = getAccountAction(actionId);
    const [status, setStatus] = React.useState('正在核对 VPS 连接与出口…');
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

    React.useEffect(() => {
      const controller = new AbortController();
      let viewer;
      let socket;
      let startupMessage;
      const disconnect = () => {
        controller.abort();
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
            setStatus('请切回已核对指纹的默认 VPS，再打开账号窗口。');
            return;
          }
          const { protocol, port } = await rpc('account-view', { targetId: preset.targetId, action: actionId }, controller.signal);
          if (controller.signal.aborted) return;
          if (typeof protocol !== 'string' || !/^dsh-account\.[\w-]{43}$/.test(protocol) ||
              !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('远程画面凭证无效。');
          const { default: RFB } = await import(new URL(accountPlayerPath, window.location.href).href);
          if (controller.signal.aborted) return;
          const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
          const host = window.location.hostname === 'localhost' ? 'localhost' : '127.0.0.1';
          socket = new WebSocket(`${scheme}://${host}:${port}${accountSocketPath}`, [protocol]);
          socket.addEventListener('close', (event) => {
            if (controller.signal.aborted || event.code !== 1011) return;
            startupMessage = accountStartupMessage(event.reason);
            if (startupMessage) {
              setStatus(startupMessage);
              setRetryable(true);
            }
          });
          viewer = new RFB(screen.current, socket, { shared: false });
          viewer.scaleViewport = true;
          viewer.addEventListener('connect', () => {
            if (!controller.signal.aborted) setStatus(action.terminal ? '已连接 VPS 账号操作窗口' : '已连接 VPS 浏览器');
          });
          viewer.addEventListener('disconnect', () => {
            if (!controller.signal.aborted) {
              setStatus(startupMessage ?? (action.terminal
                ? 'VPS 操作窗口已断开或未启动。请核对远端浏览器、xterm 和对应 CLI。'
                : 'VPS 浏览器已断开或未启动。请核对远端浏览器和出口配置。'));
              setRetryable(true);
            }
          });
        } catch (error) {
          if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
          if (!controller.signal.aborted) {
            setStatus(error.code ? error.message : '无法打开 VPS 账号窗口。');
            setRetryable(true);
          }
        }
      })();
      return disconnect;
    }, [rpc, settings, actionId, action, attempt]);

    function dismiss() {
      if (closing.current) return;
      closing.current = true;
      stop.current?.();
      dialog.current.close();
      cancelExit.current = afterPopupMotion(dialog.current, close);
    }

    function retry() {
      setRetryable(false);
      setStatus('正在核对 VPS 连接与出口…');
      setAttempt(previous => previous + 1);
    }

    return h('dialog', {
      ref: dialog, className: 'vc-account-dialog vc-popup-motion', 'aria-label': action.title,
      onCancel: (event) => { event.preventDefault(); dismiss(); },
    },
    h('header', { className: 'vc-account-header' },
      h('div', null, h('strong', null, action.title), h('div', { role: 'status' }, status)),
      h('div', { className: 'vc-account-header-actions' },
        retryable ? h('button', { type: 'button', className: 'vc-button vc-settings-outline', onClick: retry }, '重新打开') : null,
        h('button', { type: 'button', className: 'vc-button', onClick: dismiss }, '关闭账号窗口'))),
    h('p', { className: 'vc-account-tip' }, action.terminal
      ? '在下面的 VPS 画面完成操作。登录地址和验证码只在这个窗口内使用。'
      : '网页登录仅用于本次窗口。关闭后，下次打开需要重新登录。'),
    h('div', { ref: screen, className: 'vc-account-screen', 'aria-label': 'VPS 浏览器画面' }));
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
  [data-vps-chat] .vc-account-screen {min-height:0; flex:1; overflow:hidden; background:var(--vc-stage); border-radius:8px}
`;
