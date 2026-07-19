export function fieldRoutesSetupAccess({
  capabilityLoading = false,
  capabilitySucceeded = false,
  capabilityEnabled,
  savePending = false,
} = {}) {
  const explicitlyDisabled = capabilitySucceeded && capabilityEnabled === false;

  return {
    explicitlyDisabled,
    controlsDisabled: capabilityLoading || explicitlyDisabled || savePending,
  };
}
