import { IJwtPayload } from '../auth/interface/auth.interface';
import { Operator } from './operator.entity';

export class OperateContext {
  operator: Operator;
  time: Date;
  attributeMap?: Map<string, any>;

  constructor(user: IJwtPayload) {
    this.operator = {
      id: user.sub,
      code: user.username,
      name: user.name,
      roles: user.roles,
    };
    this.time = new Date();
  }

  putAttribute(key: string, value: any) {
    if (!this.attributeMap) {
      this.attributeMap = new Map<string, any>();
    }
    this.attributeMap?.set(key, value);
  }

  getAttribute(key: string): any {
    return this.attributeMap?.get(key);
  }
}
