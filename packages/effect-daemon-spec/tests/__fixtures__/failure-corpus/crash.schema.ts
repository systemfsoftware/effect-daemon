import { Schema } from 'effect'

export class ChildCrash extends Schema.TaggedError<ChildCrash, { readonly brand: unique symbol }>()('ChildCrash', {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail
  }
}
