const windows = [['fiveHour', '5 小时'], ['weekly', '每周']];
const maxResetTime = 253402300799;

export function readSubscriptionLimits(value) {
  const limits = {};
  for (const [key] of windows) {
    const window = value?.[key];
    if (Number.isFinite(window?.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 &&
        Number.isSafeInteger(window.resetsAt) && window.resetsAt > 0 && window.resetsAt <= maxResetTime) {
      limits[key] = { usedPercent: window.usedPercent, resetsAt: window.resetsAt };
    }
  }
  return limits;
}

export function readClaudeLimits(info) {
  return readSubscriptionLimits(Object.fromEntries([['five_hour', 'fiveHour'], ['seven_day', 'weekly']]
    .map(([bucket, key]) => {
      const sample = info?.unifiedWindows?.[bucket] ?? (info?.rateLimitType === bucket ? info : null);
      return [key, { usedPercent: typeof sample?.utilization === 'number' ? sample.utilization * 100 : NaN,
        resetsAt: sample?.resetsAt }];
    })));
}

export function subscriptionWindows(limits) {
  const now = Date.now();
  return windows.map(([key, label]) => {
    const sample = limits?.[key];
    const available = Boolean(sample && sample.resetsAt * 1000 > now);
    const remaining = available ? 100 - sample.usedPercent : 0;
    const percentage = Math.floor(remaining);
    const value = available ? (remaining > 0 && percentage === 0 ? '<1%' : `${percentage}%`) : '—';
    const caption = available ? `剩余 ${value}` : '暂无数据';
    const reset = available ? new Date(sample.resetsAt * 1000).toLocaleString('zh-CN') : '';
    const title = reset ? `${label} · ${caption} · ${reset} 重置` : `${label} · ${caption}`;
    return { key, label, available, remaining, value, caption, title };
  });
}

export function subscriptionMeter(h, limits) {
  const readings = subscriptionWindows(limits);
  return h('span', { className: 'vc-quota-meter', title: readings.map(({ title }) => title).join('\n') },
    ...readings.map(({ key, label, available, remaining, caption }) =>
      h('span', { key, className: 'vc-quota-ring', 'data-window': key, 'data-available': available,
        style: { '--vc-quota-fill': `${remaining}%` }, role: 'img', 'aria-label': `${label}额度，${caption}` })));
}
