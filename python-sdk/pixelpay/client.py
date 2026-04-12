"""PixelPay client — AI image & video generation with automatic payment."""

from __future__ import annotations

import json
from typing import Any, Optional
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from .errors import PixelPayError, PaymentRequiredError, PaymentChallenge

DEFAULT_BASE_URL = "https://pixelpayapi.com"
DEFAULT_TIMEOUT = 120


class PixelPay:
    """PixelPay API client.

    Args:
        base_url: API base URL (default: https://pixelpayapi.com)
        wallet: Wallet address for PXP rewards
        timeout: Request timeout in seconds (default: 120)

    Example::

        from pixelpay import PixelPay, PaymentRequiredError

        pp = PixelPay()
        models = pp.models()
        print(models["total"], "models available")

        try:
            result = pp.generate(prompt="a cat in space")
        except PaymentRequiredError as e:
            print(f"Pay {e.challenge.amount} USDC")
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        wallet: Optional[str] = None,
        timeout: int = DEFAULT_TIMEOUT,
    ):
        self.base_url = base_url.rstrip("/")
        self.wallet = wallet
        self.timeout = timeout

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[dict[str, Any]] = None,
        auth: Optional[str] = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        headers: dict[str, str] = {}

        if body is not None:
            headers["Content-Type"] = "application/json"
        if auth:
            headers["Authorization"] = auth

        data = json.dumps(body).encode() if body else None
        req = Request(url, data=data, headers=headers, method=method)

        try:
            with urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read())
        except HTTPError as e:
            resp_body = e.read().decode()
            try:
                err_data = json.loads(resp_body)
            except json.JSONDecodeError:
                err_data = {"detail": resp_body}

            if e.code == 402:
                challenge = PaymentChallenge(
                    status=402,
                    type=err_data.get("type", ""),
                    title=err_data.get("title", "Payment Required"),
                    detail=err_data.get("detail", "Payment required."),
                    amount=err_data.get("amount", ""),
                    currency=err_data.get("currency", "USDC"),
                    mpp_challenge=e.headers.get("WWW-Authenticate"),
                    x402_challenge=e.headers.get("PAYMENT-REQUIRED"),
                )
                raise PaymentRequiredError(challenge) from None

            raise PixelPayError(
                e.code,
                err_data.get("detail", str(e)),
                err_data.get("type"),
            ) from None

    # ── Image Generation ─────────────────────────────────────────────

    def generate(
        self,
        prompt: str,
        model: str = "fal-ai/flux/schnell",
        image_size: str = "landscape_4_3",
        num_images: int = 1,
        style: Optional[str] = None,
        enhance: Optional[bool] = None,
        negative_prompt: Optional[str] = None,
        seed: Optional[int] = None,
        image_urls: Optional[list[str]] = None,
        private: Optional[bool] = None,
        auth: Optional[str] = None,
    ) -> dict[str, Any]:
        """Generate images from a text prompt.

        Returns dict with keys: images, prompt, enhanced_prompt, model, timings
        """
        body: dict[str, Any] = {
            "prompt": prompt,
            "model": model,
            "image_size": image_size,
            "num_images": num_images,
        }
        if style:
            body["style"] = style
        if enhance is not None:
            body["enhance"] = enhance
        if negative_prompt:
            body["negative_prompt"] = negative_prompt
        if seed is not None:
            body["seed"] = seed
        if image_urls:
            body["image_urls"] = image_urls
        if private is not None:
            body["private"] = private
        if self.wallet:
            body["wallet"] = self.wallet
        return self._request("POST", "/v1/images/generate", body, auth)

    # ── Image Edit ───────────────────────────────────────────────────

    def edit(
        self,
        prompt: str,
        image_url: str,
        mask_url: Optional[str] = None,
        image_size: Optional[str] = None,
        auth: Optional[str] = None,
    ) -> dict[str, Any]:
        """Edit an image via inpainting/outpainting ($0.079 USDC)."""
        body: dict[str, Any] = {"prompt": prompt, "image_url": image_url}
        if mask_url:
            body["mask_url"] = mask_url
        if image_size:
            body["image_size"] = image_size
        if self.wallet:
            body["wallet"] = self.wallet
        return self._request("POST", "/v1/images/edit", body, auth)

    # ── Image Transform ──────────────────────────────────────────────

    def transform(
        self,
        prompt: str,
        image_url: Optional[str] = None,
        image_size: Optional[str] = None,
        num_images: int = 1,
        auth: Optional[str] = None,
    ) -> dict[str, Any]:
        """Transform/remix an image with style transfer ($0.049 USDC)."""
        body: dict[str, Any] = {"prompt": prompt, "num_images": num_images}
        if image_url:
            body["image_url"] = image_url
        if image_size:
            body["image_size"] = image_size
        if self.wallet:
            body["wallet"] = self.wallet
        return self._request("POST", "/v1/images/transform", body, auth)

    # ── Video Generation ─────────────────────────────────────────────

    def video(
        self,
        prompt: str,
        image_url: Optional[str] = None,
        seed: Optional[int] = None,
        auth: Optional[str] = None,
    ) -> dict[str, Any]:
        """Generate a 5-second video ($0.35 USDC)."""
        body: dict[str, Any] = {"prompt": prompt}
        if image_url:
            body["image_url"] = image_url
        if seed is not None:
            body["seed"] = seed
        if self.wallet:
            body["wallet"] = self.wallet
        return self._request("POST", "/v1/videos/generate", body, auth)

    # ── Free Endpoints ───────────────────────────────────────────────

    def models(self) -> dict[str, Any]:
        """List all available models with pricing."""
        return self._request("GET", "/v1/models")

    def prices(self) -> dict[str, Any]:
        """Get current pricing for all models."""
        return self._request("GET", "/v1/prices")

    def styles(self) -> list[str]:
        """List available style presets."""
        return self._request("GET", "/v1/styles")

    def validate(self, prompt: str) -> dict[str, Any]:
        """Validate a prompt before paying."""
        return self._request("POST", "/v1/validate", {"prompt": prompt})

    def upscale(self, image_url: str) -> dict[str, Any]:
        """Upscale an image 2x."""
        return self._request("POST", "/v1/images/upscale", {"image_url": image_url})

    def gallery(self, page: int = 1) -> Any:
        """Get public gallery."""
        return self._request("GET", f"/v1/gallery?page={page}")

    def health(self) -> dict[str, str]:
        """Health check."""
        return self._request("GET", "/health")
