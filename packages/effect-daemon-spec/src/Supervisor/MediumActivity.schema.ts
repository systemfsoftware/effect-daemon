import { Schema } from 'effect'

export const Acquired = Schema.TaggedStruct('Acquired', {})
export type Acquired = typeof Acquired.Type

export const Ready = Schema.TaggedStruct('Ready', {})
export type Ready = typeof Ready.Type

export const Released = Schema.TaggedStruct('Released', {})
export type Released = typeof Released.Type

export const MediumActivity = Schema.Union([Acquired, Ready, Released])
export type MediumActivity = typeof MediumActivity.Type
