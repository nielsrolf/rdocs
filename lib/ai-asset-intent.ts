const IMAGE_TERMS = /\b(plot|plots|figure|figures|chart|charts|image|images|visual|visuals)\b/i;
const WIDGET_TERMS = /\b(widget|widgets|explorer|explorers|interactive|rollout|rollouts|trajectory|trajectories)\b/i;

function hasAlternativeConnectorBetween(instruction: string, left: RegExp, right: RegExp) {
  const lower = instruction.toLowerCase();
  const leftMatch = lower.match(left);
  const rightMatch = lower.match(right);
  if (!leftMatch?.index || !rightMatch?.index) {
    if (leftMatch?.index !== 0 && rightMatch?.index !== 0) {
      return false;
    }
  }

  const leftIndex = leftMatch?.index ?? -1;
  const rightIndex = rightMatch?.index ?? -1;
  if (leftIndex === -1 || rightIndex === -1) {
    return false;
  }

  const start = Math.min(leftIndex, rightIndex);
  const end = Math.max(leftIndex + (leftMatch?.[0].length ?? 0), rightIndex + (rightMatch?.[0].length ?? 0));
  const between = lower.slice(start, end);
  return /\b(either|or)\b|\//.test(between);
}

export function detectEditAssetIntent(instruction: string) {
  const wantsImage = IMAGE_TERMS.test(instruction);
  const wantsWidget = WIDGET_TERMS.test(instruction);
  const acceptsEitherAsset =
    wantsImage && wantsWidget && hasAlternativeConnectorBetween(instruction, IMAGE_TERMS, WIDGET_TERMS);

  return {
    wantsImage,
    wantsWidget,
    acceptsEitherAsset,
    requiresImage: wantsImage && !acceptsEitherAsset,
    requiresWidget: wantsWidget && !acceptsEitherAsset,
    requiresAnyAsset: acceptsEitherAsset
  };
}
