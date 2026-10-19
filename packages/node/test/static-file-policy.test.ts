import { verifyStaticFilePolicy } from "../../../internal/invariants/test/helpers/static-file-policy.ts"
import * as policy from "../src/generated/static-file.ts"

verifyStaticFilePolicy("Node generated static-file policy", policy)
