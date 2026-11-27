"""Explicit configuration values, with no ambient environment/credential reads."""

from typing import Annotated, Literal, Self

from pydantic import AfterValidator, Field, model_validator

from sage.coding_contracts import _model
from sage.contracts import Backend, Contract


class Settings(Contract):
    ai_mode: Literal["local", "assistant", "api"] = "local"
    reasoning_backend: Backend | None = None
    coding_backend: Literal["none", "copilot"] = "none"
    coding_model: Annotated[str, Field(max_length=200), AfterValidator(_model)] | None = None

    @model_validator(mode="after")
    def _validate_local_backend(self) -> Self:
        if self.ai_mode == "local" and self.reasoning_backend is not None:
            self.validate_reasoning_destination(self.reasoning_backend, None)
        return self

    def validate_reasoning_destination(self, backend: str, url: str | None) -> None:
        """Gate inference before an adapter starts; URL labels prove no local runtime."""
        if self.ai_mode == "local":
            raise ValueError("Local inference is unavailable until a local runtime is reviewed")
        if backend not in {"copilot", "local", "api"}:
            raise ValueError("Unknown reasoning backend")
