export const hooks = {
  updateConfig (config) {
    return Object.assign(config, { minimumReleaseAge: 0, dangerouslyAllowAllBuilds: true })
  },
}
