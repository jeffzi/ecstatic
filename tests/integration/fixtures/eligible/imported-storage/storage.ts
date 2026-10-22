import { createWorld, register } from "ecstatic";

import { Mover } from "../../schema.js";

export const crowd = register(createWorld(), Mover);
