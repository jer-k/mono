---
title: Conclusion
slug: /byob/next
---

We've setup a simple realtime offline-enabled chat application against a vanilla serverless/Postgres stack with the help of Replicache.

It's a little bit more work than an all-in-one system like Firebase, but you can implement it directly against your own stack without reliance on a giant third-party system.

This particular application is trivial, but the techniques generalize to much more complex systems. For example, see [Repliear](https://repliear.herokuapp.com/) our realtime collaborative bug tracker.

## Next Steps

- Learn about [other backend strategies](/strategies/overview) that have better performance or flexibility.
- Learn how to [share mutator code](/howto/share-mutators) between client and server.
- Check out [Repliear](/examples/repliear), a much more fully-featured sample.
