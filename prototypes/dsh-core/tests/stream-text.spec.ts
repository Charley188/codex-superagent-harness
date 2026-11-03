import {it,expect} from 'vitest'
import {previewField} from '../panel/stream-text.ts'
it('shows streamed user-facing text without the control envelope and waits for complete escape sequences',()=>{
 const prefix='{"request_id":"x","reply":"'
 expect(previewField(prefix+'hello\\nworld','reply')).toBe('hello\nworld')
 expect(previewField(prefix+'abc\\u4e','reply')).toBe('abc')
 expect(previewField(prefix+'abc\\u4e2d','reply')).toBe('abc中')
 expect(previewField(prefix+'quoted \\"text\\"","actions":[]}','reply')).toBe('quoted "text"')
 expect(previewField('{"request_id":"x","actions":[]}','reply')).toBe('')
})
