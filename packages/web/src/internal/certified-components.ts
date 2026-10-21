/**
 * The one Vite and React release the server-component pipeline is certified against. The plugin's
 * guard and the consumer check read these; `component-certification.test.ts` holds the exact pins
 * in every manifest that runs the pipeline to them, so a range bump cannot drift past the guard.
 */
export const CERTIFIED_COMPONENT_VITE = "8.3.4"
export const CERTIFIED_COMPONENT_REACT = "19.3.1"
