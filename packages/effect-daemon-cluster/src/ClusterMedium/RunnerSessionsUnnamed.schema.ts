import { Option, Schema } from 'effect'

export class RunnerSessionsUnnamed
  extends Schema.TaggedError<RunnerSessionsUnnamed, { readonly brand: unique symbol }>()('RunnerSessionsUnnamed', {
    runnerAddress: Schema.String,
    applicationName: Schema.Option(Schema.String),
  })
{
  override get message(): string {
    const named = Option.getOrElse(this.applicationName, () => 'no application_name')
    return `the SqlClient's sessions must carry the runner address ${this.runnerAddress} as application_name, got ${named}`
  }
}
