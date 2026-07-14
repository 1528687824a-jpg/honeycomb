export function isLikelyImageGenerationModel(model: string | null | undefined) {
  return Boolean(
    model?.trim().match(
      /(dall-e|gpt-image-|imagen|cogview|wanx|seedream|doubao[-_]?seedream|doubao.*image|flux|stable-diffusion)/i
    )
  );
}

export function isLikelyVideoGenerationModel(model: string | null | undefined) {
  return Boolean(
    model?.trim().match(
      /(seedance|doubao[-_]?seedance|sora|veo|video-generation|cogvideo|kling|wanx.*video)/i
    )
  );
}

export function isLikelyMediaGenerationModel(model: string | null | undefined) {
  return isLikelyImageGenerationModel(model) || isLikelyVideoGenerationModel(model);
}
