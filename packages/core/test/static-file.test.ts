import { verifyStaticFilePolicy } from "../../../internal/invariants/test/helpers/static-file-policy.ts"
import * as policy from "../src/static-file.ts"

verifyStaticFilePolicy("core static-file policy", policy)
