from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class RegisterIn(BaseModel):
    member_id: str = Field(min_length=1, max_length=60)
    full_name: str = Field(min_length=1, max_length=120)
    group: Optional[str] = Field(default=None, max_length=80)
    notes: Optional[str] = Field(default=None, max_length=500)
    invite_code: Optional[str] = Field(default=None, max_length=80)


class MarkExportedIn(BaseModel):
    member_ids: List[str]


class GateIn(BaseModel):
    code: str = Field(default="", max_length=80)
