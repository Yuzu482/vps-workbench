const sections = {
  连接: ['连接'],
  执行端: ['模型与账号', '执行端与模型'],
  账号: ['模型与账号', '账号'],
  'Agent 预设': ['Agent 与工具', 'Agent 预设'],
  'MCP 服务器': ['Agent 与工具', 'MCP 服务器'],
  提示词模板: ['Agent 与工具', '提示词模板'],
  长期记忆: ['记忆'],
  外观: ['应用偏好', '外观'],
  交互: ['应用偏好', '交互'],
  按执行端覆盖: ['应用偏好', '按执行端覆盖'],
};

export async function openSettingsSection(dialog, name, legacy = false) {
  const [group, leaf] = legacy ? [name] : sections[name];
  await dialog.getByRole('navigation', { name: legacy ? 'VPS 设置分类' : '设置分类', exact: true })
    .getByRole('button', { name: group, exact: true }).click();
  if (leaf) await dialog.getByRole('button', { name: leaf, exact: true }).click();
}
